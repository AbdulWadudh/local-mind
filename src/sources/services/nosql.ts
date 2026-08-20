import { createLogger } from '../../core/logger';
import type { CorpusDocumentInput } from '../../corpus/corpus-service';
import type { DataSource, SourceCollectResult, SourceContext } from '../types';

import { capList, loadDriver, markdownTable, redactUrl, withConnector } from './driver';

/**
 * Schemaless stores: MongoDB, DynamoDB, Elasticsearch.
 *
 * THE INTERESTING PROBLEM HERE
 * A SQL database hands you its schema. These do not — the "schema" is whatever
 * the documents happen to contain, and it is often inconsistent. So each
 * connector *infers* structure by sampling, and then reports the inference
 * honestly: field presence as a percentage, and the set of types actually seen
 * per field.
 *
 * That honesty is the point. "`user.plan` is present in 62% of documents and is
 * sometimes a string and sometimes null" is a far more useful thing for a model
 * to know than a confident schema that is true of only some rows.
 *
 * SAMPLING READS ROW DATA. That is unavoidable for inference — you cannot infer
 * a shape without looking at instances. So values are never recorded: only field
 * names, types, and presence ratios. Enum-like fields are the one exception, and
 * only when the distinct value count is tiny and each value is short, because
 * "status is one of pending|paid|refunded" is schema, not data.
 */

const log = createLogger('sources:nosql');

/* ────────────────────────────────────────────────────────────────────────────
 * Shape inference, shared by all three
 * ──────────────────────────────────────────────────────────────────────────── */

interface FieldStat {
  types: Set<string>;
  present: number;
  /** Kept only while the field still looks enum-like. */
  values: Set<string>;
  enumLike: boolean;
}

/** Distinct-value ceiling before a field stops being treated as an enum. */
const ENUM_MAX_DISTINCT = 12;
const ENUM_MAX_VALUE_LENGTH = 40;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  const primitive = typeof value;
  if (primitive === 'object') {
    const tagged = value as { _bsontype?: string };
    return typeof tagged._bsontype === 'string' ? tagged._bsontype.toLowerCase() : 'object';
  }
  return primitive;
}

function walkDocument(
  document: Record<string, unknown>,
  stats: Map<string, FieldStat>,
  prefix = '',
  depth = 0,
): void {
  // Depth 3 covers essentially every real document shape; beyond that the field
  // list explodes and stops being readable.
  if (depth > 3) return;

  for (const [key, value] of Object.entries(document)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    const stat = stats.get(path) ?? { types: new Set(), present: 0, values: new Set(), enumLike: true };

    stat.present += 1;
    stat.types.add(typeOf(value));

    if (stat.enumLike) {
      if (typeof value === 'string' && value.length <= ENUM_MAX_VALUE_LENGTH) {
        stat.values.add(value);
        if (stat.values.size > ENUM_MAX_DISTINCT) {
          stat.enumLike = false;
          stat.values.clear();
        }
      } else if (typeof value !== 'boolean' && value !== null) {
        stat.enumLike = false;
        stat.values.clear();
      }
    }

    stats.set(path, stat);

    if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      walkDocument(value as Record<string, unknown>, stats, path, depth + 1);
    }
  }
}

function renderFieldTable(stats: Map<string, FieldStat>, sampled: number): string {
  const rows = [...stats.entries()]
    .sort((a, b) => b[1].present - a[1].present || a[0].localeCompare(b[0]))
    .map(([path, stat]) => {
      const presence = sampled === 0 ? '—' : `${Math.round((stat.present / sampled) * 100)}%`;
      const values =
        stat.enumLike && stat.values.size > 0 && stat.values.size <= ENUM_MAX_DISTINCT
          ? [...stat.values].sort().map((value) => `\`${value}\``).join(', ')
          : '—';
      return [`\`${path}\``, [...stat.types].sort().join(' \\| '), presence, values];
    });

  const { shown, omitted } = capList(rows, 120);
  const table = markdownTable(['Field', 'Types', 'Presence', 'Observed values'], shown);
  return omitted > 0 ? `${table}\n\n_(${omitted} further fields omitted)_` : table;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 60);
}

/* ────────────────────────────────────────────────────────────────────────────
 * MongoDB
 * ──────────────────────────────────────────────────────────────────────────── */

type MongoDriver = {
  MongoClient: new (url: string, options?: Record<string, unknown>) => MongoClientLike;
};
type MongoClientLike = {
  connect: () => Promise<unknown>;
  close: () => Promise<void>;
  db: (name?: string) => MongoDbLike;
};
type MongoDbLike = {
  databaseName: string;
  listCollections: () => { toArray: () => Promise<{ name: string; type?: string }[]> };
  collection: (name: string) => MongoCollectionLike;
};
type MongoCollectionLike = {
  estimatedDocumentCount: () => Promise<number>;
  find: (filter: Record<string, unknown>) => { limit: (n: number) => { toArray: () => Promise<Record<string, unknown>[]> } };
  indexes: () => Promise<Record<string, unknown>[]>;
};

export interface MongoSourceOptions {
  readonly url: string;
  readonly database?: string;
  readonly label?: string;
  /** Documents sampled per collection for shape inference. */
  readonly sampleSize?: number;
}

export function mongodbSource(options: MongoSourceOptions): DataSource {
  const safeUrl = redactUrl(options.url);
  const label = options.label ?? options.database ?? 'mongodb';
  const ref = `mongodb:${label}`;
  const sampleSize = options.sampleSize ?? 200;

  return {
    kind: 'mongodb',
    ref,
    label,

    async collect(context: SourceContext): Promise<SourceCollectResult> {
      context.onProgress?.({ stage: 'connect', detail: safeUrl });

      const driver = await loadDriver<MongoDriver>({ specifier: 'mongodb', label: 'MongoDB' });
      const client = new driver.MongoClient(options.url, { serverSelectionTimeoutMS: 15_000 });

      return withConnector(
        'MongoDB',
        async () => {
          await client.connect();
          try {
            const db = client.db(options.database);
            const collections = (await db.listCollections().toArray()).filter(
              (entry) => entry.type !== 'view' || true,
            );

            const documents: CorpusDocumentInput[] = [];
            const base = { origin: 'service' as const, sourceRef: ref, tags: ['mongodb', 'schema', label] };
            const summary: string[][] = [];

            for (const [index, entry] of collections.entries()) {
              context.onProgress?.({
                stage: 'sample',
                detail: entry.name,
                done: index + 1,
                total: collections.length,
              });

              const collection = db.collection(entry.name);
              const count = await collection.estimatedDocumentCount().catch(() => 0);
              const sample = await collection.find({}).limit(sampleSize).toArray().catch(() => []);

              const stats = new Map<string, FieldStat>();
              for (const document of sample) walkDocument(document, stats);

              const indexes = await collection.indexes().catch(() => []);
              summary.push([`\`${entry.name}\``, String(count), String(stats.size), String(indexes.length)]);

              documents.push({
                ...base,
                id: `svc-${slug(ref)}-coll-${slug(entry.name)}`,
                title: `${label} — collection ${entry.name}`,
                sourcePath: `${safeUrl}#${entry.name}`,
                tags: [...base.tags, 'collection'],
                text: [
                  `# ${entry.name}`,
                  '',
                  `A MongoDB collection in \`${db.databaseName}\` with approximately ${count} documents.`,
                  `The field list below is **inferred** from a sample of ${sample.length} document(s), so presence`,
                  'percentages describe the sample rather than the whole collection.',
                  '',
                  '## Fields',
                  '',
                  renderFieldTable(stats, sample.length),
                  '',
                  indexes.length > 0
                    ? [
                        '## Indexes',
                        '',
                        ...indexes.map(
                          (definition) =>
                            `- \`${String(definition['name'] ?? 'unnamed')}\` on ${JSON.stringify(definition['key'] ?? {})}`,
                        ),
                      ].join('\n')
                    : '',
                ]
                  .filter((line) => line !== '')
                  .join('\n'),
              });
            }

            documents.unshift({
              ...base,
              id: `svc-${slug(ref)}-overview`,
              title: `${label} — MongoDB overview`,
              sourcePath: safeUrl,
              text: [
                `# ${label} — MongoDB overview`,
                '',
                `${collections.length} collections. Field shapes are inferred by sampling; no field values are recorded`,
                'except small enum-like sets.',
                '',
                markdownTable(['Collection', 'Approx. documents', 'Inferred fields', 'Indexes'], summary),
              ].join('\n'),
            });

            log.info('mongodb collected', { label, collections: collections.length });

            return {
              documents,
              warnings:
                collections.length === 0
                  ? ['No collections were visible. Check the database name and the user permissions.']
                  : [],
              detectedServices: [],
              stats: { database: db.databaseName, collections: collections.length, documents: documents.length },
            };
          } finally {
            await client.close();
          }
        },
        'Check the connection string and network reachability. Install the driver with `bun add mongodb`.',
      );
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * DynamoDB
 * ──────────────────────────────────────────────────────────────────────────── */

type DynamoDriver = {
  DynamoDBClient: new (config: Record<string, unknown>) => { send: (command: unknown) => Promise<Record<string, unknown>> };
  ListTablesCommand: new (input: Record<string, unknown>) => unknown;
  DescribeTableCommand: new (input: Record<string, unknown>) => unknown;
  ScanCommand: new (input: Record<string, unknown>) => unknown;
};

export interface DynamoSourceOptions {
  readonly region: string;
  readonly endpoint?: string;
  readonly label?: string;
  readonly sampleSize?: number;
}

export function dynamodbSource(options: DynamoSourceOptions): DataSource {
  const label = options.label ?? `dynamodb-${options.region}`;
  const ref = `dynamodb:${label}`;

  return {
    kind: 'dynamodb',
    ref,
    label,

    async collect(context: SourceContext): Promise<SourceCollectResult> {
      context.onProgress?.({ stage: 'connect', detail: options.region });

      const driver = await loadDriver<DynamoDriver>({
        specifier: '@aws-sdk/client-dynamodb',
        label: 'DynamoDB',
      });

      return withConnector(
        'DynamoDB',
        async () => {
          const client = new driver.DynamoDBClient({
            region: options.region,
            ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
          });

          const listed = await client.send(new driver.ListTablesCommand({ Limit: 100 }));
          const names = (listed['TableNames'] as string[] | undefined) ?? [];

          const base = { origin: 'service' as const, sourceRef: ref, tags: ['dynamodb', 'schema', label] };
          const documents: CorpusDocumentInput[] = [];
          const summary: string[][] = [];

          for (const [index, name] of names.entries()) {
            context.onProgress?.({ stage: 'describe', detail: name, done: index + 1, total: names.length });

            const described = await client.send(new driver.DescribeTableCommand({ TableName: name }));
            const table = (described['Table'] ?? {}) as Record<string, unknown>;
            const keySchema = (table['KeySchema'] as { AttributeName?: string; KeyType?: string }[] | undefined) ?? [];
            const attributes =
              (table['AttributeDefinitions'] as { AttributeName?: string; AttributeType?: string }[] | undefined) ?? [];
            const gsis = (table['GlobalSecondaryIndexes'] as { IndexName?: string }[] | undefined) ?? [];
            const itemCount = Number(table['ItemCount'] ?? 0);

            // DynamoDB only declares *key* attributes, so non-key fields must be
            // inferred by sampling, exactly as with MongoDB.
            const stats = new Map<string, FieldStat>();
            let sampled = 0;
            try {
              const scanned = await client.send(
                new driver.ScanCommand({ TableName: name, Limit: options.sampleSize ?? 100 }),
              );
              const items = (scanned['Items'] as Record<string, unknown>[] | undefined) ?? [];
              sampled = items.length;
              // Items arrive in AttributeValue form: { S: "x" }, { N: "1" }.
              for (const item of items) {
                const flattened: Record<string, unknown> = {};
                for (const [key, wrapped] of Object.entries(item)) {
                  const descriptor = wrapped as Record<string, unknown>;
                  const tag = Object.keys(descriptor)[0] ?? 'unknown';
                  flattened[key] = tag === 'NULL' ? null : tag;
                }
                walkDocument(flattened, stats);
              }
            } catch (error) {
              log.warn('dynamodb scan denied; key schema only', { table: name, error: String(error).slice(0, 120) });
            }

            summary.push([`\`${name}\``, String(itemCount), String(keySchema.length), String(gsis.length)]);

            documents.push({
              ...base,
              id: `svc-${slug(ref)}-table-${slug(name)}`,
              title: `${label} — table ${name}`,
              sourcePath: `dynamodb://${options.region}/${name}`,
              tags: [...base.tags, 'table'],
              text: [
                `# ${name}`,
                '',
                `A DynamoDB table in \`${options.region}\` with approximately ${itemCount} items.`,
                '',
                '## Key schema',
                '',
                markdownTable(
                  ['Attribute', 'Key type', 'Data type'],
                  keySchema.map((key) => [
                    `\`${key.AttributeName ?? ''}\``,
                    key.KeyType === 'HASH' ? 'partition' : 'sort',
                    attributes.find((attribute) => attribute.AttributeName === key.AttributeName)?.AttributeType ?? '—',
                  ]),
                ),
                '',
                gsis.length > 0
                  ? `## Global secondary indexes\n\n${gsis.map((index) => `- \`${index.IndexName ?? 'unnamed'}\``).join('\n')}\n`
                  : '',
                stats.size > 0
                  ? [
                      '## Inferred attributes',
                      '',
                      `Inferred from a sample of ${sampled} item(s). Values are shown as DynamoDB type tags, not data.`,
                      '',
                      renderFieldTable(stats, sampled),
                    ].join('\n')
                  : '_No sample was available (scan may be denied); only the key schema is documented._',
              ]
                .filter((line) => line !== '')
                .join('\n'),
            });
          }

          documents.unshift({
            ...base,
            id: `svc-${slug(ref)}-overview`,
            title: `${label} — DynamoDB overview`,
            sourcePath: `dynamodb://${options.region}`,
            text: [
              `# ${label} — DynamoDB overview`,
              '',
              `${names.length} tables in region \`${options.region}\`.`,
              '',
              markdownTable(['Table', 'Approx. items', 'Key attributes', 'GSIs'], summary),
            ].join('\n'),
          });

          log.info('dynamodb collected', { region: options.region, tables: names.length });

          return {
            documents,
            warnings: names.length === 0 ? ['No tables were listed. Check the region and IAM permissions.'] : [],
            detectedServices: [],
            stats: { region: options.region, tables: names.length, documents: documents.length },
          };
        },
        'Check AWS credentials in the environment (AWS_ACCESS_KEY_ID / AWS_PROFILE) and that the role may ListTables and DescribeTable. Install the driver with `bun add @aws-sdk/client-dynamodb`.',
      );
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Elasticsearch / OpenSearch
 * ──────────────────────────────────────────────────────────────────────────── */

type ElasticDriver = {
  Client: new (config: Record<string, unknown>) => {
    indices: {
      get: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
      stats: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    close: () => Promise<void>;
  };
};

export interface ElasticSourceOptions {
  readonly node: string;
  readonly apiKey?: string;
  readonly username?: string;
  readonly password?: string;
  readonly label?: string;
  /** Index pattern. Defaults to everything except internal indices. */
  readonly indexPattern?: string;
}

/** Flatten an Elasticsearch mapping tree into `field.path: type` pairs. */
function flattenMapping(properties: Record<string, unknown>, prefix = ''): { path: string; type: string }[] {
  const out: { path: string; type: string }[] = [];

  for (const [name, raw] of Object.entries(properties)) {
    const definition = raw as { type?: string; properties?: Record<string, unknown>; fields?: Record<string, unknown> };
    const path = prefix === '' ? name : `${prefix}.${name}`;

    if (definition.properties !== undefined) {
      out.push({ path, type: 'object' });
      out.push(...flattenMapping(definition.properties, path));
      continue;
    }

    out.push({ path, type: definition.type ?? 'unknown' });

    // Multi-fields (`title.keyword`) matter for queries, so surface them.
    if (definition.fields !== undefined) {
      for (const [subName, subRaw] of Object.entries(definition.fields)) {
        const sub = subRaw as { type?: string };
        out.push({ path: `${path}.${subName}`, type: sub.type ?? 'unknown' });
      }
    }
  }

  return out;
}

export function elasticsearchSource(options: ElasticSourceOptions): DataSource {
  const label = options.label ?? new URL(options.node).host;
  const ref = `elasticsearch:${label}`;

  return {
    kind: 'elasticsearch',
    ref,
    label,

    async collect(context: SourceContext): Promise<SourceCollectResult> {
      context.onProgress?.({ stage: 'connect', detail: redactUrl(options.node) });

      const driver = await loadDriver<ElasticDriver>({
        specifier: '@elastic/elasticsearch',
        label: 'Elasticsearch',
      });

      return withConnector(
        'Elasticsearch',
        async () => {
          const client = new driver.Client({
            node: options.node,
            requestTimeout: 20_000,
            ...(options.apiKey !== undefined ? { auth: { apiKey: options.apiKey } } : {}),
            ...(options.username !== undefined
              ? { auth: { username: options.username, password: options.password ?? '' } }
              : {}),
          });

          try {
            const pattern = options.indexPattern ?? '*,-.*';
            const mappings = await client.indices.get({ index: pattern });

            let stats: Record<string, unknown> = {};
            try {
              stats = await client.indices.stats({ index: pattern });
            } catch {
              // Stats can be denied independently of mappings; doc counts are
              // a nice-to-have and the mapping is the substance.
            }

            const indexStats = ((stats['indices'] ?? {}) as Record<string, { primaries?: { docs?: { count?: number } } }>);
            const base = { origin: 'service' as const, sourceRef: ref, tags: ['elasticsearch', 'schema', label] };
            const documents: CorpusDocumentInput[] = [];
            const summary: string[][] = [];

            for (const [indexName, raw] of Object.entries(mappings)) {
              const definition = raw as { mappings?: { properties?: Record<string, unknown> } };
              const properties = definition.mappings?.properties ?? {};
              const fields = flattenMapping(properties);
              const docCount = indexStats[indexName]?.primaries?.docs?.count ?? 0;

              summary.push([`\`${indexName}\``, String(docCount), String(fields.length)]);

              const { shown, omitted } = capList(fields, 150);

              documents.push({
                ...base,
                id: `svc-${slug(ref)}-index-${slug(indexName)}`,
                title: `${label} — index ${indexName}`,
                sourcePath: `${redactUrl(options.node)}/${indexName}`,
                tags: [...base.tags, 'index'],
                text: [
                  `# ${indexName}`,
                  '',
                  `An Elasticsearch index on \`${label}\` holding approximately ${docCount} documents.`,
                  'The mapping below is declared by the cluster, not inferred.',
                  '',
                  '## Mapping',
                  '',
                  markdownTable(
                    ['Field', 'Type'],
                    shown.map((field) => [`\`${field.path}\``, field.type]),
                  ),
                  omitted > 0 ? `\n_(${omitted} further fields omitted)_` : '',
                ]
                  .filter((line) => line !== '')
                  .join('\n'),
              });
            }

            documents.unshift({
              ...base,
              id: `svc-${slug(ref)}-overview`,
              title: `${label} — Elasticsearch overview`,
              sourcePath: redactUrl(options.node),
              text: [
                `# ${label} — Elasticsearch overview`,
                '',
                `${documents.length} indices matching \`${pattern}\`.`,
                '',
                markdownTable(['Index', 'Approx. documents', 'Mapped fields'], summary),
              ].join('\n'),
            });

            log.info('elasticsearch collected', { label, indices: summary.length });

            return {
              documents,
              warnings: summary.length === 0 ? [`No indices matched \`${pattern}\`.`] : [],
              detectedServices: [],
              stats: { cluster: label, indices: summary.length, documents: documents.length },
            };
          } finally {
            await client.close();
          }
        },
        'Check the node URL and credentials, and that the user may read index mappings. Install the driver with `bun add @elastic/elasticsearch`.',
      );
    },
  };
}
