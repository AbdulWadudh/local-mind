import { createLogger } from '../../core/logger';
import type { CorpusDocumentInput } from '../../corpus/corpus-service';
import type { DataSource, SourceCollectResult, SourceContext } from '../types';

import { capList, loadDriver, markdownTable, redactUrl, withConnector } from './driver';

/**
 * Infrastructure connectors: S3-compatible object storage, and Redis.
 *
 * These two are the clearest illustration of the rule that governs every
 * connector here: **document the shape, never the contents.**
 *
 * For S3 that means bucket names, prefix hierarchy, object counts, size
 * distribution and content types — the information you need to answer "where do
 * we put invoice PDFs" — and never an object body.
 *
 * For Redis it means the keyspace *pattern* set. Redis has no schema at all, so
 * the useful artefact is the inferred key grammar: `session:{id}`,
 * `cache:user:{id}:profile`. That is derived by scanning keys and collapsing the
 * variable segments, so what gets stored is the grammar, not the keys.
 */

const log = createLogger('sources:infra');

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 60);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * S3-compatible object storage
 * ──────────────────────────────────────────────────────────────────────────── */

type S3Driver = {
  S3Client: new (config: Record<string, unknown>) => { send: (command: unknown) => Promise<Record<string, unknown>> };
  ListBucketsCommand: new (input: Record<string, unknown>) => unknown;
  ListObjectsV2Command: new (input: Record<string, unknown>) => unknown;
  GetBucketLocationCommand: new (input: Record<string, unknown>) => unknown;
};

export interface S3SourceOptions {
  readonly region: string;
  /** Set for MinIO, Cloudflare R2, Wasabi, or any other S3-compatible endpoint. */
  readonly endpoint?: string;
  readonly forcePathStyle?: boolean;
  /** Limit to specific buckets. Defaults to every bucket the credentials can list. */
  readonly buckets?: readonly string[];
  readonly label?: string;
  /** Objects listed per bucket while profiling. */
  readonly sampleSize?: number;
  readonly credentials?: { readonly accessKeyId: string; readonly secretAccessKey: string };
}

interface PrefixStat {
  objects: number;
  bytes: number;
  contentTypes: Set<string>;
  newest: string;
  oldest: string;
}

export function s3Source(options: S3SourceOptions): DataSource {
  const label = options.label ?? (options.endpoint !== undefined ? new URL(options.endpoint).host : options.region);
  const ref = `s3:${label}`;
  const sampleSize = options.sampleSize ?? 1000;

  return {
    kind: 's3',
    ref,
    label,

    async collect(context: SourceContext): Promise<SourceCollectResult> {
      context.onProgress?.({ stage: 'connect', detail: options.endpoint ?? options.region });

      const driver = await loadDriver<S3Driver>({ specifier: '@aws-sdk/client-s3', label: 'S3' });

      return withConnector(
        'S3',
        async () => {
          const client = new driver.S3Client({
            region: options.region,
            ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
            ...(options.forcePathStyle === true ? { forcePathStyle: true } : {}),
            ...(options.credentials !== undefined ? { credentials: options.credentials } : {}),
          });

          let bucketNames: string[];
          if (options.buckets !== undefined && options.buckets.length > 0) {
            bucketNames = [...options.buckets];
          } else {
            const listed = await client.send(new driver.ListBucketsCommand({}));
            bucketNames = ((listed['Buckets'] as { Name?: string }[] | undefined) ?? [])
              .map((bucket) => bucket.Name)
              .filter((name): name is string => typeof name === 'string');
          }

          const base = { origin: 'service' as const, sourceRef: ref, tags: ['s3', 'storage', label] };
          const documents: CorpusDocumentInput[] = [];
          const summary: string[][] = [];
          const warnings: string[] = [];

          for (const [index, bucket] of bucketNames.entries()) {
            context.onProgress?.({ stage: 'profile', detail: bucket, done: index + 1, total: bucketNames.length });

            // Two passes. The delimiter pass gives the top-level "folder"
            // structure cheaply; the flat pass profiles sizes and types. A
            // fully recursive listing of a large bucket is unbounded work.
            let topLevel: string[] = [];
            const prefixes = new Map<string, PrefixStat>();
            let totalObjects = 0;
            let totalBytes = 0;

            try {
              const delimited = await client.send(
                new driver.ListObjectsV2Command({ Bucket: bucket, Delimiter: '/', MaxKeys: 1000 }),
              );
              topLevel = ((delimited['CommonPrefixes'] as { Prefix?: string }[] | undefined) ?? [])
                .map((entry) => entry.Prefix)
                .filter((prefix): prefix is string => typeof prefix === 'string');

              const flat = await client.send(
                new driver.ListObjectsV2Command({ Bucket: bucket, MaxKeys: sampleSize }),
              );
              const objects =
                (flat['Contents'] as { Key?: string; Size?: number; LastModified?: Date }[] | undefined) ?? [];

              for (const object of objects) {
                if (object.Key === undefined) continue;
                totalObjects += 1;
                totalBytes += object.Size ?? 0;

                const segments = object.Key.split('/');
                const prefix = segments.length > 1 ? `${segments.slice(0, -1).join('/')}/` : '(root)';
                const stat =
                  prefixes.get(prefix) ??
                  { objects: 0, bytes: 0, contentTypes: new Set<string>(), newest: '', oldest: '' };

                stat.objects += 1;
                stat.bytes += object.Size ?? 0;

                const extension = object.Key.includes('.') ? (object.Key.split('.').pop() ?? '') : '';
                if (extension.length > 0 && extension.length <= 8) stat.contentTypes.add(extension.toLowerCase());

                const modified = object.LastModified?.toISOString() ?? '';
                if (modified !== '') {
                  if (stat.newest === '' || modified > stat.newest) stat.newest = modified;
                  if (stat.oldest === '' || modified < stat.oldest) stat.oldest = modified;
                }

                prefixes.set(prefix, stat);
              }

              if (flat['IsTruncated'] === true) {
                warnings.push(`Bucket \`${bucket}\` has more than ${sampleSize} objects; the profile is a sample.`);
              }
            } catch (error) {
              warnings.push(`Could not list \`${bucket}\`: ${String(error).slice(0, 120)}`);
              continue;
            }

            summary.push([`\`${bucket}\``, String(totalObjects), formatBytes(totalBytes), String(prefixes.size)]);

            const { shown: prefixRows, omitted } = capList(
              [...prefixes.entries()].sort((a, b) => b[1].objects - a[1].objects),
              60,
            );

            documents.push({
              ...base,
              id: `svc-${slug(ref)}-bucket-${slug(bucket)}`,
              title: `${label} — bucket ${bucket}`,
              sourcePath: `s3://${bucket}`,
              tags: [...base.tags, 'bucket'],
              text: [
                `# s3://${bucket}`,
                '',
                `An object storage bucket on \`${label}\`. Profiled from a sample of ${totalObjects} object(s)`,
                `totalling ${formatBytes(totalBytes)}. Object contents were not read.`,
                '',
                topLevel.length > 0
                  ? `## Top-level prefixes\n\n${topLevel.map((prefix) => `- \`${prefix}\``).join('\n')}\n`
                  : '',
                '## Prefix profile',
                '',
                markdownTable(
                  ['Prefix', 'Objects', 'Size', 'File types', 'Newest object'],
                  prefixRows.map(([prefix, stat]) => [
                    `\`${prefix}\``,
                    String(stat.objects),
                    formatBytes(stat.bytes),
                    [...stat.contentTypes].sort().slice(0, 6).join(', ') || '—',
                    stat.newest.slice(0, 10) || '—',
                  ]),
                ),
                omitted > 0 ? `\n_(${omitted} further prefixes omitted)_` : '',
              ]
                .filter((line) => line !== '')
                .join('\n'),
            });
          }

          documents.unshift({
            ...base,
            id: `svc-${slug(ref)}-overview`,
            title: `${label} — object storage overview`,
            sourcePath: options.endpoint ?? `s3://${options.region}`,
            text: [
              `# ${label} — object storage overview`,
              '',
              `${bucketNames.length} bucket(s)${options.endpoint !== undefined ? ` on \`${redactUrl(options.endpoint)}\`` : ` in region \`${options.region}\``}.`,
              '',
              markdownTable(['Bucket', 'Sampled objects', 'Sampled size', 'Prefixes'], summary),
            ].join('\n'),
          });

          log.info('s3 collected', { label, buckets: bucketNames.length });

          return {
            documents,
            warnings,
            detectedServices: [],
            stats: { endpoint: options.endpoint ?? options.region, buckets: bucketNames.length, documents: documents.length },
          };
        },
        'Check AWS credentials (AWS_ACCESS_KEY_ID / AWS_PROFILE) and that the role may ListBucket. Install the driver with `bun add @aws-sdk/client-s3`.',
      );
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Redis
 * ──────────────────────────────────────────────────────────────────────────── */

type RedisDriver = {
  default: new (url: string, options?: Record<string, unknown>) => RedisClientLike;
  Redis?: new (url: string, options?: Record<string, unknown>) => RedisClientLike;
};
type RedisClientLike = {
  scan: (cursor: string, ...args: (string | number)[]) => Promise<[string, string[]]>;
  type: (key: string) => Promise<string>;
  ttl: (key: string) => Promise<number>;
  info: (section?: string) => Promise<string>;
  dbsize: () => Promise<number>;
  quit: () => Promise<unknown>;
};

export interface RedisSourceOptions {
  readonly url: string;
  readonly label?: string;
  /** Keys scanned to infer the key grammar. */
  readonly sampleSize?: number;
}

/**
 * Collapse a concrete key into a pattern.
 *
 * `session:8f2c-...:meta` becomes `session:{id}:meta`. The heuristics look for
 * the segment shapes that are in practice always identifiers: UUIDs, hex blobs,
 * pure digits, and long opaque tokens. Getting this roughly right turns 50,000
 * keys into a dozen documented patterns.
 */
export function inferKeyPattern(key: string): string {
  const separator = key.includes(':') ? ':' : key.includes('/') ? '/' : ':';

  return key
    .split(separator)
    .map((segment) => {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(segment)) return '{uuid}';
      if (/^\d+$/u.test(segment)) return '{n}';
      if (/^[0-9a-f]{16,}$/iu.test(segment)) return '{hex}';
      if (/^[A-Za-z0-9_-]{20,}$/u.test(segment)) return '{token}';
      if (/^\d{4}-\d{2}-\d{2}$/u.test(segment)) return '{date}';
      if (/@/u.test(segment)) return '{email}';
      return segment;
    })
    .join(separator);
}

export function redisSource(options: RedisSourceOptions): DataSource {
  const safeUrl = redactUrl(options.url);
  const label = options.label ?? (() => {
    try {
      return new URL(options.url).host;
    } catch {
      return 'redis';
    }
  })();
  const ref = `redis:${label}`;
  const sampleSize = options.sampleSize ?? 5000;

  return {
    kind: 'redis',
    ref,
    label,

    async collect(context: SourceContext): Promise<SourceCollectResult> {
      context.onProgress?.({ stage: 'connect', detail: safeUrl });

      const driver = await loadDriver<RedisDriver>({ specifier: 'ioredis', label: 'Redis (ioredis)' });
      const Constructor = driver.default ?? driver.Redis;

      if (Constructor === undefined) {
        return {
          documents: [],
          warnings: ['The ioredis module did not export a usable client constructor.'],
          detectedServices: [],
          stats: {},
        };
      }

      const client = new Constructor(options.url, {
        maxRetriesPerRequest: 1,
        connectTimeout: 10_000,
        lazyConnect: false,
      });

      return withConnector(
        'Redis',
        async () => {
          try {
            const dbSize = await client.dbsize();

            // SCAN, never KEYS: KEYS blocks the server for the duration, which on
            // a production instance is an outage caused by a documentation tool.
            const patterns = new Map<string, { count: number; types: Set<string>; ttls: number[] }>();
            let cursor = '0';
            let scanned = 0;

            do {
              const [next, keys] = await client.scan(cursor, 'COUNT', 500);
              cursor = next;

              for (const key of keys) {
                if (scanned >= sampleSize) break;
                scanned += 1;

                const pattern = inferKeyPattern(key);
                const entry = patterns.get(pattern) ?? { count: 0, types: new Set<string>(), ttls: [] };
                entry.count += 1;

                // Type/TTL lookups are two round trips per key, so only probe the
                // first few keys of each pattern - the rest are the same shape.
                if (entry.count <= 3) {
                  entry.types.add(await client.type(key).catch(() => 'unknown'));
                  const ttl = await client.ttl(key).catch(() => -1);
                  if (ttl > 0) entry.ttls.push(ttl);
                }

                patterns.set(pattern, entry);
              }
            } while (cursor !== '0' && scanned < sampleSize);

            const rows = [...patterns.entries()]
              .sort((a, b) => b[1].count - a[1].count)
              .map(([pattern, entry]) => [
                `\`${pattern}\``,
                String(entry.count),
                [...entry.types].sort().join(', ') || 'unknown',
                entry.ttls.length > 0
                  ? `${Math.round(entry.ttls.reduce((sum, ttl) => sum + ttl, 0) / entry.ttls.length)}s`
                  : 'none',
              ]);

            const { shown, omitted } = capList(rows, 80);

            const documents: CorpusDocumentInput[] = [
              {
                origin: 'service',
                sourceRef: ref,
                tags: ['redis', 'cache', label],
                id: `svc-${slug(ref)}-keyspace`,
                title: `${label} — Redis keyspace`,
                sourcePath: safeUrl,
                text: [
                  `# ${label} — Redis keyspace`,
                  '',
                  `The instance holds ${dbSize} keys. ${scanned} were sampled with SCAN and collapsed into`,
                  `${patterns.size} key pattern(s). Variable segments are shown as \`{uuid}\`, \`{n}\`, \`{hex}\`,`,
                  '`{token}`, `{date}` or `{email}`. No key values were read.',
                  '',
                  '## Key patterns',
                  '',
                  markdownTable(['Pattern', 'Sampled keys', 'Redis types', 'Typical TTL'], shown),
                  omitted > 0 ? `\n_(${omitted} further patterns omitted)_` : '',
                ]
                  .filter((line) => line !== '')
                  .join('\n'),
              },
            ];

            log.info('redis collected', { label, keys: dbSize, patterns: patterns.size });

            return {
              documents,
              warnings: dbSize === 0 ? ['The Redis instance is empty.'] : [],
              detectedServices: [],
              stats: { instance: label, keys: dbSize, sampled: scanned, patterns: patterns.size },
            };
          } finally {
            await client.quit().catch(() => undefined);
          }
        },
        'Check the Redis URL and that the instance is reachable. Install the driver with `bun add ioredis`.',
      );
    },
  };
}
