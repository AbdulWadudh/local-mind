import { parse as parseYaml } from 'yaml';

import { createLogger } from '../../core/logger';
import { describeUnknownError } from '../../core/errors';
import type { DetectedService, ServiceKind } from '../types';

import type { Repository } from './repository';

/**
 * Service detection: reading a repository to work out what it talks to.
 *
 * This is deliberately deterministic - no model involved. Four independent
 * signals, and a service is reported when any of them fires:
 *
 *   1. DEPENDENCIES. A package manifest naming `pg`, `@aws-sdk/client-s3`,
 *      `ioredis`. Strongest signal: a dependency is a compile-time commitment.
 *   2. COMPOSE / IaC. A `docker-compose.yml` service image, or a Terraform
 *      resource type. Tells you what runs alongside the code.
 *   3. ENVIRONMENT. `DATABASE_URL`, `S3_BUCKET`, `REDIS_HOST` in `.env.example`.
 *      Names the credential the connector will need.
 *   4. SCHEMA ARTEFACTS. `schema.prisma`, `openapi.yaml`, `*.graphql`.
 *
 * Confidence is a function of how many independent signals agree. That matters
 * for the UI: a `high` service is offered as "connect this", a `low` one as
 * "we think you might use this - is that right?". Guessing loudly is worse than
 * guessing tentatively.
 */

const log = createLogger('sources:github:detect');

interface Rule {
  readonly kind: ServiceKind;
  readonly label: string;
  /** Package names, matched exactly or as a prefix ending in `/`. */
  readonly packages: readonly string[];
  /** Substrings matched against docker-compose image names and IaC resources. */
  readonly images: readonly string[];
  /** Regexes matched against env var NAMES. */
  readonly envPatterns: readonly RegExp[];
  readonly connectorAvailable: boolean;
}

const RULES: readonly Rule[] = [
  {
    kind: 'postgres',
    label: 'PostgreSQL',
    packages: ['pg', 'postgres', 'pg-promise', 'knex', 'drizzle-orm', 'prisma', '@prisma/client', 'typeorm', 'sequelize', 'psycopg2', 'psycopg', 'asyncpg', 'sqlalchemy', 'lib/pq', 'pgx', 'slonik', 'kysely', '@neondatabase/serverless', 'postgres.js'],
    images: ['postgres', 'postgis', 'timescale', 'pgvector', 'aws_db_instance', 'google_sql_database'],
    envPatterns: [/^DATABASE_URL$/u, /^POSTGRES_/u, /^PG(HOST|USER|PASSWORD|DATABASE|PORT)$/u, /^DB_(HOST|URL|NAME|USER|PASSWORD)$/u, /^NEON_/u, /^SUPABASE_DB_URL$/u],
    connectorAvailable: true,
  },
  {
    kind: 'mysql',
    label: 'MySQL / MariaDB',
    packages: ['mysql', 'mysql2', 'mariadb', 'PyMySQL', 'mysqlclient', 'go-sql-driver/mysql'],
    images: ['mysql', 'mariadb', 'percona'],
    envPatterns: [/^MYSQL_/u, /^MARIADB_/u],
    connectorAvailable: true,
  },
  {
    kind: 'mongodb',
    label: 'MongoDB',
    packages: ['mongodb', 'mongoose', 'pymongo', 'motor', 'mongo-driver'],
    images: ['mongo', 'mongodb', 'documentdb'],
    envPatterns: [/^MONGO(DB)?_/u, /^MONGO_URI$/u, /^MONGODB_URI$/u],
    connectorAvailable: true,
  },
  {
    kind: 'redis',
    label: 'Redis / Valkey',
    packages: ['redis', 'ioredis', 'node-redis', '@upstash/redis', 'redis-py', 'go-redis'],
    images: ['redis', 'valkey', 'keydb', 'elasticache'],
    envPatterns: [/^REDIS_/u, /^UPSTASH_REDIS_/u, /^CACHE_URL$/u],
    connectorAvailable: true,
  },
  {
    kind: 's3',
    label: 'S3-compatible object storage',
    packages: ['@aws-sdk/client-s3', 'aws-sdk', 'boto3', 'minio', '@aws-sdk/s3-request-presigner', 'aws-sdk-go'],
    images: ['minio', 'localstack', 'aws_s3_bucket', 'google_storage_bucket'],
    envPatterns: [/^S3_/u, /^AWS_S3_/u, /^BUCKET(_NAME)?$/u, /^R2_/u, /^MINIO_/u],
    connectorAvailable: true,
  },
  {
    kind: 'dynamodb',
    label: 'DynamoDB',
    packages: ['@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb', 'dynamoose', 'aws-dynamodb'],
    images: ['dynamodb-local', 'aws_dynamodb_table'],
    envPatterns: [/^DYNAMO(DB)?_/u, /^AWS_DYNAMODB_/u],
    connectorAvailable: true,
  },
  {
    kind: 'elasticsearch',
    label: 'Elasticsearch / OpenSearch',
    packages: ['@elastic/elasticsearch', '@opensearch-project/opensearch', 'elasticsearch', 'elasticsearch-py', 'opensearch-py'],
    images: ['elasticsearch', 'opensearch', 'aws_opensearch'],
    envPatterns: [/^(ELASTIC|ELASTICSEARCH|OPENSEARCH)_/u, /^ES_(URL|HOST|NODE)$/u],
    connectorAvailable: true,
  },
  {
    kind: 'kafka',
    label: 'Kafka / Redpanda',
    packages: ['kafkajs', 'node-rdkafka', 'confluent-kafka', 'kafka-python', 'sarama'],
    images: ['kafka', 'redpanda', 'confluentinc', 'msk'],
    envPatterns: [/^KAFKA_/u, /^BROKERS?$/u, /^REDPANDA_/u],
    connectorAvailable: false,
  },
  {
    kind: 'rabbitmq',
    label: 'RabbitMQ',
    packages: ['amqplib', 'amqp-connection-manager', 'pika', 'kombu'],
    images: ['rabbitmq'],
    envPatterns: [/^RABBIT(MQ)?_/u, /^AMQP_URL$/u],
    connectorAvailable: false,
  },
  {
    kind: 'clickhouse',
    label: 'ClickHouse',
    packages: ['@clickhouse/client', 'clickhouse-driver', 'clickhouse-connect'],
    images: ['clickhouse'],
    envPatterns: [/^CLICKHOUSE_/u],
    connectorAvailable: false,
  },
  {
    kind: 'snowflake',
    label: 'Snowflake',
    packages: ['snowflake-sdk', 'snowflake-connector-python'],
    images: [],
    envPatterns: [/^SNOWFLAKE_/u],
    connectorAvailable: false,
  },
  {
    kind: 'bigquery',
    label: 'BigQuery',
    packages: ['@google-cloud/bigquery', 'google-cloud-bigquery'],
    images: ['google_bigquery'],
    envPatterns: [/^BIGQUERY_/u, /^GOOGLE_CLOUD_PROJECT$/u],
    connectorAvailable: false,
  },
  {
    kind: 'supabase',
    label: 'Supabase',
    packages: ['@supabase/supabase-js', '@supabase/ssr', 'supabase'],
    images: ['supabase'],
    envPatterns: [/^SUPABASE_/u, /^NEXT_PUBLIC_SUPABASE_/u],
    connectorAvailable: true,
  },
  {
    kind: 'firebase',
    label: 'Firebase / Firestore',
    packages: ['firebase', 'firebase-admin', '@google-cloud/firestore'],
    images: ['firebase'],
    envPatterns: [/^FIREBASE_/u, /^FIRESTORE_/u],
    connectorAvailable: false,
  },
];

interface Signal {
  readonly evidence: string;
  readonly envVars: readonly string[];
  readonly weight: number;
}

function matchesPackage(dependency: string, candidates: readonly string[]): boolean {
  const normalised = dependency.toLowerCase();
  return candidates.some((candidate) => {
    const target = candidate.toLowerCase();
    return normalised === target || normalised.startsWith(`${target}/`) || normalised.endsWith(`/${target}`);
  });
}

/** Every dependency name across every manifest format we can read. */
function collectDependencies(contents: Map<string, string>): { name: string; from: string }[] {
  const found: { name: string; from: string }[] = [];

  for (const [path, raw] of contents) {
    const file = path.split('/').pop() ?? path;

    if (file === 'package.json') {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
          const block = parsed[field];
          if (block !== null && typeof block === 'object') {
            for (const name of Object.keys(block as Record<string, unknown>)) found.push({ name, from: path });
          }
        }
      } catch {
        // Malformed manifest: the other signals still apply.
      }
      continue;
    }

    if (file === 'requirements.txt' || file === 'Pipfile') {
      for (const line of raw.split('\n')) {
        const name = line.trim().split(/[=<>~!;[\s]/u)[0];
        if (name !== undefined && name.length > 0 && !name.startsWith('#')) found.push({ name, from: path });
      }
      continue;
    }

    if (file === 'pyproject.toml' || file === 'Cargo.toml' || file === 'mix.exs') {
      for (const match of raw.matchAll(/^\s*["']?([a-zA-Z0-9_.-]+)["']?\s*[=:]/gmu)) {
        const name = match[1];
        if (name !== undefined) found.push({ name, from: path });
      }
      continue;
    }

    if (file === 'go.mod') {
      for (const match of raw.matchAll(/^\s*([\w./-]+)\s+v[\d]/gmu)) {
        const name = match[1];
        if (name !== undefined) found.push({ name, from: path });
      }
      continue;
    }

    if (file === 'pom.xml' || file.startsWith('build.gradle')) {
      for (const match of raw.matchAll(/<artifactId>([^<]+)<\/artifactId>|["']([\w.-]+:[\w.-]+)/gu)) {
        const name = match[1] ?? match[2];
        if (name !== undefined) found.push({ name, from: path });
      }
      continue;
    }

    if (file === 'Gemfile' || file === 'composer.json') {
      for (const match of raw.matchAll(/["']([\w./-]+)["']/gu)) {
        const name = match[1];
        if (name !== undefined) found.push({ name, from: path });
      }
    }
  }

  return found;
}

/** Docker Compose service images, plus raw image strings from Dockerfiles. */
function collectImages(contents: Map<string, string>): { image: string; from: string }[] {
  const found: { image: string; from: string }[] = [];

  for (const [path, raw] of contents) {
    const file = path.split('/').pop() ?? path;

    if (/^(docker-)?compose\.ya?ml$/u.test(file)) {
      try {
        const parsed = parseYaml(raw) as { services?: Record<string, { image?: unknown }> } | null;
        const services = parsed?.services;
        if (services !== undefined && services !== null) {
          for (const [name, definition] of Object.entries(services)) {
            const image = definition?.image;
            found.push({ image: typeof image === 'string' ? image : name, from: path });
          }
        }
      } catch (error) {
        log.debug('compose file unparseable', { path, error: describeUnknownError(error) });
      }
      continue;
    }

    if (file === 'Dockerfile' || file.startsWith('Dockerfile.')) {
      for (const match of raw.matchAll(/^\s*FROM\s+([^\s]+)/gimu)) {
        const image = match[1];
        if (image !== undefined) found.push({ image, from: path });
      }
      continue;
    }

    if (path.endsWith('.tf') || path.endsWith('.hcl')) {
      for (const match of raw.matchAll(/resource\s+"([^"]+)"/gu)) {
        const resource = match[1];
        if (resource !== undefined) found.push({ image: resource, from: path });
      }
    }
  }

  return found;
}

/** Env var names from `.env.*` samples and `process.env.X` / `os.environ` reads. */
export function collectEnvVars(contents: Map<string, string>): { name: string; from: string }[] {
  const found: { name: string; from: string }[] = [];

  for (const [path, raw] of contents) {
    const file = path.split('/').pop() ?? path;

    if (file.startsWith('.env')) {
      for (const match of raw.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gmu)) {
        const name = match[1];
        if (name !== undefined) found.push({ name, from: path });
      }
      continue;
    }

    for (const pattern of [
      /process\.env(?:\.|\[["'])([A-Z][A-Z0-9_]*)/gu,
      /Bun\.env(?:\.|\[["'])([A-Z][A-Z0-9_]*)/gu,
      /os\.(?:environ|getenv)(?:\.get)?\(?\[?["']([A-Z][A-Z0-9_]*)["']/gu,
      /os\.Getenv\(["']([A-Z][A-Z0-9_]*)["']\)/gu,
      /env::var\(["']([A-Z][A-Z0-9_]*)["']\)/gu,
      /ENV\[["']([A-Z][A-Z0-9_]*)["']\]/gu,
    ]) {
      for (const match of raw.matchAll(pattern)) {
        const name = match[1];
        if (name !== undefined) found.push({ name, from: path });
      }
    }
  }

  return found;
}

export interface DetectionInput {
  readonly repository: Repository;
  /** Already-read file contents. Reused so we do not read manifests twice. */
  readonly contents: Map<string, string>;
}

export interface DetectionResult {
  readonly services: readonly DetectedService[];
  readonly dependencies: readonly string[];
  readonly envVars: readonly string[];
}

export function detectServices(input: DetectionInput): DetectionResult {
  const { contents, repository } = input;

  const dependencies = collectDependencies(contents);
  const images = collectImages(contents);
  const envVars = collectEnvVars(contents);

  const dependencyNames = [...new Set(dependencies.map((entry) => entry.name))].sort();
  const envVarNames = [...new Set(envVars.map((entry) => entry.name))].sort();

  const services: DetectedService[] = [];

  for (const rule of RULES) {
    const signals: Signal[] = [];

    for (const dependency of dependencies) {
      if (matchesPackage(dependency.name, rule.packages)) {
        signals.push({ evidence: `dependency "${dependency.name}" in ${dependency.from}`, envVars: [], weight: 3 });
      }
    }

    for (const image of images) {
      const haystack = image.image.toLowerCase();
      if (rule.images.some((needle) => haystack.includes(needle.toLowerCase()))) {
        signals.push({ evidence: `container/resource "${image.image}" in ${image.from}`, envVars: [], weight: 2 });
      }
    }

    const matchedEnv = envVarNames.filter((name) => rule.envPatterns.some((pattern) => pattern.test(name)));
    if (matchedEnv.length > 0) {
      signals.push({
        evidence: `environment variables ${matchedEnv.slice(0, 4).join(', ')}`,
        envVars: matchedEnv,
        weight: 2,
      });
    }

    if (signals.length === 0) continue;

    // De-duplicate evidence lines: three files declaring `pg` is one signal, and
    // a wall of near-identical evidence makes the UI unreadable.
    const evidence = [...new Set(signals.map((signal) => signal.evidence))].slice(0, 5);
    const weight = signals.reduce((sum, signal) => sum + signal.weight, 0);
    const distinctKinds = new Set(signals.map((signal) => signal.weight)).size;

    services.push({
      kind: rule.kind,
      label: rule.label,
      evidence,
      envVars: [...new Set(signals.flatMap((signal) => signal.envVars))],
      connectorAvailable: rule.connectorAvailable,
      confidence: weight >= 5 || distinctKinds >= 2 ? 'high' : weight >= 3 ? 'medium' : 'low',
    });
  }

  // Schema artefacts are their own signal and do not fit the rule table.
  const openapiFile = repository.files.find((file) => /(^|\/)(openapi|swagger)\.(ya?ml|json)$/u.test(file.path));
  if (openapiFile !== undefined) {
    services.push({
      kind: 'openapi',
      label: 'OpenAPI specification',
      evidence: [`spec file ${openapiFile.path}`],
      envVars: [],
      connectorAvailable: true,
      confidence: 'high',
    });
  }

  const graphqlFile = repository.files.find((file) => /\.(graphql|gql)$/u.test(file.path));
  if (graphqlFile !== undefined) {
    services.push({
      kind: 'graphql',
      label: 'GraphQL schema',
      evidence: [`schema file ${graphqlFile.path}`],
      envVars: envVarNames.filter((name) => /GRAPHQL|GQL/u.test(name)),
      connectorAvailable: true,
      confidence: 'high',
    });
  }

  services.sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 } as const;
    return rank[a.confidence] - rank[b.confidence] || a.label.localeCompare(b.label);
  });

  log.info('services detected', {
    count: services.length,
    kinds: services.map((service) => service.kind).join(','),
  });

  return { services, dependencies: dependencyNames, envVars: envVarNames };
}
