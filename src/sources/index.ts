import { LocalMindError } from '../core/errors';
import type { CorpusDocumentInput } from '../corpus/corpus-service';

import { githubSource } from './github';
import { dynamodbSource, elasticsearchSource, mongodbSource } from './services/nosql';
import { graphqlSource, openapiSource } from './services/api';
import { redisSource, s3Source } from './services/infra';
import { mysqlSource, postgresSource } from './services/sql';
import type { DataSource, ServiceKind, SourceCollectResult, SourceContext } from './types';

/**
 * The source registry.
 *
 * Two jobs. First, a barrel: one import site for every connector. Second, and
 * more usefully, a *descriptor table* — the Studio UI needs to render a
 * connection form for a service it has only detected by name, and hard-coding
 * nine forms in the frontend would put the knowledge of what Postgres needs in
 * two places. Instead the backend describes each connector's fields, and the UI
 * renders whatever it is told.
 */

export type { DataSource, DetectedService, ServiceKind, SourceCollectResult, SourceContext, SourceProgress } from './types';
export { SERVICE_KINDS, emptyResult } from './types';

export { githubSource, parseRepoSpec, detectServices } from './github';
export type { GithubSourceOptions } from './github';
export type { Repository, RepoFile } from './github';

export { postgresSource, mysqlSource, sqlSource } from './services/sql';
export type { SqlSourceOptions, SqlDialect } from './services/sql';

export { mongodbSource, dynamodbSource, elasticsearchSource } from './services/nosql';
export type { MongoSourceOptions, DynamoSourceOptions, ElasticSourceOptions } from './services/nosql';

export { s3Source, redisSource, inferKeyPattern } from './services/infra';
export type { S3SourceOptions, RedisSourceOptions } from './services/infra';

export { openapiSource, graphqlSource } from './services/api';
export type { OpenApiSourceOptions, GraphqlSourceOptions } from './services/api';

export { redactUrl } from './services/driver';

/* ────────────────────────────────────────────────────────────────────────────
 * Descriptors: what each connector needs to be configured
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ConnectorField {
  readonly name: string;
  readonly label: string;
  readonly type: 'text' | 'password' | 'number' | 'boolean';
  readonly required: boolean;
  readonly placeholder?: string;
  readonly help?: string;
  /** Env var this is conventionally read from, shown as a hint in the UI. */
  readonly envHint?: string;
}

export interface ConnectorDescriptor {
  readonly kind: ServiceKind;
  readonly label: string;
  /** npm package the user must install. Absent when no driver is needed. */
  readonly driver?: string;
  readonly summary: string;
  /** What ends up in the corpus, so the user knows what they are about to ingest. */
  readonly produces: string;
  /** Stated plainly, because people are right to ask. */
  readonly readsRowData: boolean;
  readonly fields: readonly ConnectorField[];
}

export const CONNECTORS: readonly ConnectorDescriptor[] = [
  {
    kind: 'postgres',
    label: 'PostgreSQL',
    driver: 'postgres',
    summary: 'Introspects information_schema for tables, columns, keys, indexes, enums and COMMENT text.',
    produces: 'One document per table, plus a schema overview.',
    readsRowData: false,
    fields: [
      {
        name: 'url',
        label: 'Connection URL',
        type: 'password',
        required: true,
        placeholder: 'postgres://user:pass@host:5432/db',
        envHint: 'DATABASE_URL',
        help: 'Read once to connect; never stored by LocalMind.',
      },
      { name: 'schemas', label: 'Schemas (comma separated)', type: 'text', required: false, placeholder: 'public' },
      { name: 'includeRowCounts', label: 'Include approximate row counts', type: 'boolean', required: false },
    ],
  },
  {
    kind: 'mysql',
    label: 'MySQL / MariaDB',
    driver: 'mysql2',
    summary: 'Introspects information_schema for tables, columns, keys, indexes and column comments.',
    produces: 'One document per table, plus a schema overview.',
    readsRowData: false,
    fields: [
      {
        name: 'url',
        label: 'Connection URL',
        type: 'password',
        required: true,
        placeholder: 'mysql://user:pass@host:3306/db',
        envHint: 'MYSQL_URL',
      },
      { name: 'schemas', label: 'Schemas (comma separated)', type: 'text', required: false },
    ],
  },
  {
    kind: 'mongodb',
    label: 'MongoDB',
    driver: 'mongodb',
    summary: 'Samples documents per collection and infers field names, types and presence rates.',
    produces: 'One document per collection, plus an overview.',
    readsRowData: true,
    fields: [
      {
        name: 'url',
        label: 'Connection URL',
        type: 'password',
        required: true,
        placeholder: 'mongodb://user:pass@host:27017',
        envHint: 'MONGODB_URI',
      },
      { name: 'database', label: 'Database', type: 'text', required: false },
      {
        name: 'sampleSize',
        label: 'Documents to sample per collection',
        type: 'number',
        required: false,
        placeholder: '200',
        help: 'Values are read to infer types but are never stored, except small enum-like sets.',
      },
    ],
  },
  {
    kind: 'redis',
    label: 'Redis / Valkey',
    driver: 'ioredis',
    summary: 'SCANs the keyspace and collapses keys into patterns such as session:{uuid}:meta.',
    produces: 'One keyspace document listing patterns, types and typical TTLs.',
    readsRowData: false,
    fields: [
      {
        name: 'url',
        label: 'Connection URL',
        type: 'password',
        required: true,
        placeholder: 'redis://host:6379',
        envHint: 'REDIS_URL',
      },
      { name: 'sampleSize', label: 'Keys to scan', type: 'number', required: false, placeholder: '5000' },
    ],
  },
  {
    kind: 's3',
    label: 'S3-compatible storage',
    driver: '@aws-sdk/client-s3',
    summary: 'Lists buckets and profiles prefixes: object counts, sizes, file types, recency.',
    produces: 'One document per bucket, plus an overview. Object bodies are never read.',
    readsRowData: false,
    fields: [
      { name: 'region', label: 'Region', type: 'text', required: true, placeholder: 'us-east-1', envHint: 'AWS_REGION' },
      {
        name: 'endpoint',
        label: 'Custom endpoint',
        type: 'text',
        required: false,
        placeholder: 'https://…r2.cloudflarestorage.com',
        help: 'Set for MinIO, Cloudflare R2, Wasabi and other S3-compatible services.',
      },
      { name: 'buckets', label: 'Buckets (comma separated)', type: 'text', required: false, help: 'Defaults to every listable bucket.' },
      { name: 'forcePathStyle', label: 'Force path-style addressing', type: 'boolean', required: false },
    ],
  },
  {
    kind: 'dynamodb',
    label: 'DynamoDB',
    driver: '@aws-sdk/client-dynamodb',
    summary: 'Describes tables for key schema and GSIs, then samples items to infer non-key attributes.',
    produces: 'One document per table, plus an overview.',
    readsRowData: true,
    fields: [
      { name: 'region', label: 'Region', type: 'text', required: true, placeholder: 'us-east-1', envHint: 'AWS_REGION' },
      { name: 'endpoint', label: 'Custom endpoint', type: 'text', required: false, help: 'For DynamoDB Local.' },
      { name: 'sampleSize', label: 'Items to sample per table', type: 'number', required: false, placeholder: '100' },
    ],
  },
  {
    kind: 'elasticsearch',
    label: 'Elasticsearch / OpenSearch',
    driver: '@elastic/elasticsearch',
    summary: 'Reads declared index mappings, including multi-fields, plus document counts.',
    produces: 'One document per index, plus an overview.',
    readsRowData: false,
    fields: [
      { name: 'node', label: 'Node URL', type: 'text', required: true, placeholder: 'https://localhost:9200', envHint: 'ELASTICSEARCH_URL' },
      { name: 'apiKey', label: 'API key', type: 'password', required: false },
      { name: 'username', label: 'Username', type: 'text', required: false },
      { name: 'password', label: 'Password', type: 'password', required: false },
      { name: 'indexPattern', label: 'Index pattern', type: 'text', required: false, placeholder: '*,-.*' },
    ],
  },
  {
    kind: 'openapi',
    label: 'OpenAPI / Swagger',
    summary: 'Parses the specification, resolving local $refs into readable type signatures.',
    produces: 'One document per operation, plus an API overview.',
    readsRowData: false,
    fields: [
      { name: 'url', label: 'Specification URL', type: 'text', required: false, placeholder: 'https://api.example.com/openapi.json' },
      { name: 'path', label: 'Local file path', type: 'text', required: false, placeholder: './openapi.yaml' },
    ],
  },
  {
    kind: 'graphql',
    label: 'GraphQL',
    summary: 'Runs an introspection query and documents root operations and every named type.',
    produces: 'One document per type, plus documents for Query and Mutation.',
    readsRowData: false,
    fields: [
      { name: 'url', label: 'Endpoint URL', type: 'text', required: true, placeholder: 'https://api.example.com/graphql' },
      {
        name: 'headers',
        label: 'Headers (JSON)',
        type: 'password',
        required: false,
        placeholder: '{"authorization":"Bearer …"}',
        help: 'Introspection is often disabled in production; a staging endpoint usually works.',
      },
    ],
  },
];

export function findConnector(kind: string): ConnectorDescriptor | undefined {
  return CONNECTORS.find((connector) => connector.kind === kind);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Building a source from a plain config object (what the HTTP API receives)
 * ──────────────────────────────────────────────────────────────────────────── */

function requireString(config: Record<string, unknown>, field: string, kind: string): string {
  const value = config[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LocalMindError('CONFIG_INVALID', `Connector "${kind}" requires "${field}".`, {
      remedy: `Supply a value for ${field}.`,
    });
  }
  return value.trim();
}

function optionalString(config: Record<string, unknown>, field: string): string | undefined {
  const value = config[field];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalNumber(config: Record<string, unknown>, field: string): number | undefined {
  const value = config[field];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function optionalList(config: Record<string, unknown>, field: string): string[] | undefined {
  const value = config[field];
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter((entry) => entry.length > 0);
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  }
  return undefined;
}

/**
 * Turn `{ kind, ...config }` into a `DataSource`.
 *
 * This is the single place the HTTP layer crosses from untrusted JSON into typed
 * connector options, so all the validation lives here rather than being sprayed
 * across nine route handlers.
 */
export function createSource(kind: string, config: Record<string, unknown>): DataSource {
  switch (kind) {
    case 'github':
      return githubSource({
        ...(optionalString(config, 'repo') !== undefined ? { repo: optionalString(config, 'repo') as string } : {}),
        ...(optionalString(config, 'path') !== undefined ? { path: optionalString(config, 'path') as string } : {}),
        ...(optionalString(config, 'ref') !== undefined ? { ref: optionalString(config, 'ref') as string } : {}),
        ...(optionalString(config, 'token') !== undefined ? { token: optionalString(config, 'token') as string } : {}),
        ...(config['skipSynthesis'] === true ? { skipSynthesis: true } : {}),
      });

    case 'postgres':
      return postgresSource({
        url: requireString(config, 'url', kind),
        ...(optionalList(config, 'schemas') !== undefined ? { schemas: optionalList(config, 'schemas') as string[] } : {}),
        ...(config['includeRowCounts'] === false ? { includeRowCounts: false } : {}),
      });

    case 'mysql':
      return mysqlSource({
        url: requireString(config, 'url', kind),
        ...(optionalList(config, 'schemas') !== undefined ? { schemas: optionalList(config, 'schemas') as string[] } : {}),
      });

    case 'mongodb':
      return mongodbSource({
        url: requireString(config, 'url', kind),
        ...(optionalString(config, 'database') !== undefined ? { database: optionalString(config, 'database') as string } : {}),
        ...(optionalNumber(config, 'sampleSize') !== undefined ? { sampleSize: optionalNumber(config, 'sampleSize') as number } : {}),
      });

    case 'redis':
      return redisSource({
        url: requireString(config, 'url', kind),
        ...(optionalNumber(config, 'sampleSize') !== undefined ? { sampleSize: optionalNumber(config, 'sampleSize') as number } : {}),
      });

    case 's3':
      return s3Source({
        region: requireString(config, 'region', kind),
        ...(optionalString(config, 'endpoint') !== undefined ? { endpoint: optionalString(config, 'endpoint') as string } : {}),
        ...(optionalList(config, 'buckets') !== undefined ? { buckets: optionalList(config, 'buckets') as string[] } : {}),
        ...(config['forcePathStyle'] === true ? { forcePathStyle: true } : {}),
        ...(optionalNumber(config, 'sampleSize') !== undefined ? { sampleSize: optionalNumber(config, 'sampleSize') as number } : {}),
      });

    case 'dynamodb':
      return dynamodbSource({
        region: requireString(config, 'region', kind),
        ...(optionalString(config, 'endpoint') !== undefined ? { endpoint: optionalString(config, 'endpoint') as string } : {}),
        ...(optionalNumber(config, 'sampleSize') !== undefined ? { sampleSize: optionalNumber(config, 'sampleSize') as number } : {}),
      });

    case 'elasticsearch':
      return elasticsearchSource({
        node: requireString(config, 'node', kind),
        ...(optionalString(config, 'apiKey') !== undefined ? { apiKey: optionalString(config, 'apiKey') as string } : {}),
        ...(optionalString(config, 'username') !== undefined ? { username: optionalString(config, 'username') as string } : {}),
        ...(optionalString(config, 'password') !== undefined ? { password: optionalString(config, 'password') as string } : {}),
        ...(optionalString(config, 'indexPattern') !== undefined ? { indexPattern: optionalString(config, 'indexPattern') as string } : {}),
      });

    case 'openapi': {
      const url = optionalString(config, 'url');
      const path = optionalString(config, 'path');
      if (url === undefined && path === undefined) {
        throw new LocalMindError('CONFIG_INVALID', 'The OpenAPI connector needs either a URL or a file path.', {
          remedy: 'Supply `url` or `path`.',
        });
      }
      return openapiSource({
        ...(url !== undefined ? { url } : {}),
        ...(path !== undefined ? { path } : {}),
      });
    }

    case 'graphql': {
      const rawHeaders = optionalString(config, 'headers');
      let headers: Record<string, string> | undefined;
      if (rawHeaders !== undefined) {
        try {
          headers = JSON.parse(rawHeaders) as Record<string, string>;
        } catch {
          throw new LocalMindError('CONFIG_INVALID', 'The GraphQL `headers` field must be a JSON object.', {
            remedy: 'For example: {"authorization":"Bearer abc"}',
          });
        }
      }
      return graphqlSource({
        url: requireString(config, 'url', kind),
        ...(headers !== undefined ? { headers } : {}),
      });
    }

    default:
      throw new LocalMindError('CONFIG_INVALID', `Unknown source kind "${kind}".`, {
        remedy: `Supported kinds: github, ${CONNECTORS.map((connector) => connector.kind).join(', ')}.`,
      });
  }
}

/** Run a source and return its documents. Thin, but it is the seam tests use. */
export async function collectSource(
  source: DataSource,
  context: SourceContext = {},
): Promise<SourceCollectResult & { documents: readonly CorpusDocumentInput[] }> {
  return source.collect(context);
}
