import { createLogger } from '../../core/logger';
import type { CorpusDocumentInput } from '../../corpus/corpus-service';
import type { DataSource, SourceCollectResult, SourceContext } from '../types';

import { capList, loadAnyDriver, markdownTable, redactUrl, withConnector } from './driver';

/**
 * SQL schema introspection: PostgreSQL and MySQL/MariaDB.
 *
 * WHY THIS IS THE MOST VALUABLE CONNECTOR
 * A repository tells you what the code *intends*. The database tells you what is
 * actually there: the column somebody added by hand in 2023, the table the ORM
 * models no longer match, the foreign key that documents a relationship nothing
 * in the code makes explicit. For questions like "where do we store refund
 * state", the schema is the authoritative answer and the code is a lossy
 * summary of it.
 *
 * WHAT IT READS, AND WHAT IT REFUSES TO READ
 * Reads: tables, columns, types, nullability, defaults, primary keys, foreign
 * keys, indexes, views, enums, and — most valuable of all — `COMMENT ON` text,
 * which is documentation someone wrote next to the thing it documents.
 *
 * Refuses: row data. Not one value. A RAG corpus is embedded, stored, and shown
 * to a model; putting customer rows through that is a data-protection incident
 * with extra steps. Row *counts* are read because they convey scale without
 * conveying content.
 */

const log = createLogger('sources:sql');

export type SqlDialect = 'postgres' | 'mysql';

interface ColumnRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
  column_comment?: string | null;
}

interface ConstraintRow {
  table_schema: string;
  table_name: string;
  constraint_name: string;
  constraint_type: string;
  column_name: string | null;
  referenced_table: string | null;
  referenced_column: string | null;
}

interface TableRow {
  table_schema: string;
  table_name: string;
  table_type: string;
  table_comment?: string | null;
  estimated_rows?: number | string | null;
}

/** Minimal shape of `postgres` (porsager) — a tagged-template query function. */
type PostgresDriver = {
  default: (url: string, options?: Record<string, unknown>) => PostgresClient;
};
type PostgresClient = {
  unsafe: (query: string) => Promise<Record<string, unknown>[]>;
  end: () => Promise<void>;
};

/** Minimal shape of `mysql2/promise`. */
type MysqlDriver = {
  createConnection: (url: string) => Promise<MysqlConnection>;
};
type MysqlConnection = {
  query: (sql: string) => Promise<[Record<string, unknown>[], unknown]>;
  end: () => Promise<void>;
};

const POSTGRES_QUERIES = {
  tables: `
    SELECT c.table_schema, c.table_name, c.table_type,
           obj_description(pc.oid) AS table_comment,
           pc.reltuples::bigint    AS estimated_rows
      FROM information_schema.tables c
      LEFT JOIN pg_class pc ON pc.relname = c.table_name
      LEFT JOIN pg_namespace pn ON pn.oid = pc.relnamespace AND pn.nspname = c.table_schema
     WHERE c.table_schema NOT IN ('pg_catalog','information_schema','pg_toast')
     ORDER BY c.table_schema, c.table_name`,
  columns: `
    SELECT c.table_schema, c.table_name, c.column_name,
           -- information_schema reports every enum, domain and composite as the
           -- useless string 'USER-DEFINED'. udt_name carries the actual type, and
           -- for a schema document the enum name is the whole point.
           CASE WHEN c.data_type = 'USER-DEFINED' THEN c.udt_name ELSE c.data_type END AS data_type,
           c.is_nullable, c.column_default, c.character_maximum_length,
           col_description(pc.oid, c.ordinal_position) AS column_comment
      FROM information_schema.columns c
      LEFT JOIN pg_class pc ON pc.relname = c.table_name
      LEFT JOIN pg_namespace pn ON pn.oid = pc.relnamespace AND pn.nspname = c.table_schema
     WHERE c.table_schema NOT IN ('pg_catalog','information_schema','pg_toast')
     ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
  constraints: `
    SELECT tc.table_schema, tc.table_name, tc.constraint_name, tc.constraint_type,
           kcu.column_name,
           ccu.table_name  AS referenced_table,
           ccu.column_name AS referenced_column
      FROM information_schema.table_constraints tc
      LEFT JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
      LEFT JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
     WHERE tc.table_schema NOT IN ('pg_catalog','information_schema')
     ORDER BY tc.table_schema, tc.table_name`,
  indexes: `
    SELECT schemaname AS table_schema, tablename AS table_name,
           indexname  AS index_name,  indexdef  AS definition
      FROM pg_indexes
     WHERE schemaname NOT IN ('pg_catalog','information_schema')
     ORDER BY schemaname, tablename`,
  enums: `
    SELECT n.nspname AS schema_name, t.typname AS enum_name,
           string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) AS values
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname NOT IN ('pg_catalog','information_schema')
     GROUP BY 1, 2 ORDER BY 1, 2`,
} as const;

const MYSQL_QUERIES = {
  tables: `
    SELECT table_schema, table_name, table_type, table_comment,
           table_rows AS estimated_rows
      FROM information_schema.tables
     WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys')
     ORDER BY table_schema, table_name`,
  columns: `
    SELECT table_schema, table_name, column_name, data_type,
           is_nullable, column_default, character_maximum_length,
           column_comment
      FROM information_schema.columns
     WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys')
     ORDER BY table_schema, table_name, ordinal_position`,
  constraints: `
    SELECT tc.table_schema, tc.table_name, tc.constraint_name, tc.constraint_type,
           kcu.column_name,
           kcu.referenced_table_name  AS referenced_table,
           kcu.referenced_column_name AS referenced_column
      FROM information_schema.table_constraints tc
      LEFT JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name
            AND kcu.table_schema = tc.table_schema
            AND kcu.table_name = tc.table_name
     WHERE tc.table_schema NOT IN ('mysql','information_schema','performance_schema','sys')
     ORDER BY tc.table_schema, tc.table_name`,
  indexes: `
    SELECT table_schema, table_name, index_name,
           GROUP_CONCAT(column_name ORDER BY seq_in_index) AS definition
      FROM information_schema.statistics
     WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys')
     GROUP BY table_schema, table_name, index_name
     ORDER BY table_schema, table_name`,
} as const;

export interface SqlSourceOptions {
  /** Connection URL. Read from env by the caller; never persisted by LocalMind. */
  readonly url: string;
  readonly dialect: SqlDialect;
  /** Restrict to these schemas. Defaults to every non-system schema. */
  readonly schemas?: readonly string[];
  /** Label used in document titles. Defaults to the database name from the URL. */
  readonly label?: string;
  /**
   * Include approximate row counts. On by default: scale is context a model
   * genuinely uses ("this table has 40 million rows" changes the answer).
   */
  readonly includeRowCounts?: boolean;
}

function databaseNameFromUrl(url: string, fallback: string): string {
  try {
    const parsed = new URL(url);
    const name = parsed.pathname.replace(/^\//u, '').split('?')[0];
    return name !== undefined && name.length > 0 ? name : fallback;
  } catch {
    return fallback;
  }
}

function str(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function num(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function runPostgres(url: string): Promise<Record<string, Record<string, unknown>[]>> {
  const { driver } = await loadAnyDriver<PostgresDriver>([
    { specifier: 'postgres', label: 'PostgreSQL (postgres.js)' },
  ]);

  const client = driver.default(url, { max: 1, idle_timeout: 5, connect_timeout: 15 });
  try {
    const out: Record<string, Record<string, unknown>[]> = {};
    for (const [name, query] of Object.entries(POSTGRES_QUERIES)) {
      try {
        out[name] = await client.unsafe(query);
      } catch (error) {
        // A restricted role may be denied `pg_class` or `pg_indexes`. Losing the
        // index list is far better than losing the whole schema.
        log.warn('postgres query failed; continuing', { query: name, error: String(error).slice(0, 140) });
        out[name] = [];
      }
    }
    return out;
  } finally {
    await client.end();
  }
}

async function runMysql(url: string): Promise<Record<string, Record<string, unknown>[]>> {
  const { driver } = await loadAnyDriver<MysqlDriver>([
    { specifier: 'mysql2/promise', label: 'MySQL (mysql2)' },
  ]);

  const connection = await driver.createConnection(url);
  try {
    const out: Record<string, Record<string, unknown>[]> = {};
    for (const [name, query] of Object.entries(MYSQL_QUERIES)) {
      try {
        const [rows] = await connection.query(query);
        out[name] = rows;
      } catch (error) {
        log.warn('mysql query failed; continuing', { query: name, error: String(error).slice(0, 140) });
        out[name] = [];
      }
    }
    return out;
  } finally {
    await connection.end();
  }
}

/**
 * One document per table, plus a schema overview.
 *
 * Per-table granularity is a retrieval decision, not a cosmetic one. A single
 * "here is the whole schema" document would be one embedding for eighty tables,
 * so a query about `refunds` would score the same as a query about `sessions`.
 * One document per table gives each table its own point in vector space.
 */
function buildDocuments(input: {
  label: string;
  dialect: SqlDialect;
  sourceRef: string;
  safeUrl: string;
  tables: TableRow[];
  columns: ColumnRow[];
  constraints: ConstraintRow[];
  indexes: Record<string, unknown>[];
  enums: Record<string, unknown>[];
  includeRowCounts: boolean;
}): CorpusDocumentInput[] {
  const { label, dialect, sourceRef } = input;
  const base = { origin: 'service' as const, sourceRef, tags: [dialect, 'schema', label] };
  const documents: CorpusDocumentInput[] = [];

  const key = (schema: string, table: string): string => `${schema}.${table}`;

  const columnsByTable = new Map<string, ColumnRow[]>();
  for (const column of input.columns) {
    const id = key(column.table_schema, column.table_name);
    const list = columnsByTable.get(id) ?? [];
    list.push(column);
    columnsByTable.set(id, list);
  }

  const constraintsByTable = new Map<string, ConstraintRow[]>();
  for (const constraint of input.constraints) {
    const id = key(constraint.table_schema, constraint.table_name);
    const list = constraintsByTable.get(id) ?? [];
    list.push(constraint);
    constraintsByTable.set(id, list);
  }

  const indexesByTable = new Map<string, string[]>();
  for (const index of input.indexes) {
    const id = key(str(index['table_schema']), str(index['table_name']));
    const list = indexesByTable.get(id) ?? [];
    list.push(`${str(index['index_name'])}: ${str(index['definition'])}`);
    indexesByTable.set(id, list);
  }

  // ── Overview ─────────────────────────────────────────────────────────────
  const tableRows = input.tables.map((table) => {
    const id = key(table.table_schema, table.table_name);
    const columnCount = columnsByTable.get(id)?.length ?? 0;
    return [
      `\`${id}\``,
      table.table_type.toLowerCase().includes('view') ? 'view' : 'table',
      String(columnCount),
      input.includeRowCounts ? formatRowCount(table.estimated_rows) : '—',
      str(table.table_comment).slice(0, 80) || '—',
    ];
  });

  documents.push({
    ...base,
    id: `svc-${slug(sourceRef)}-overview`,
    title: `${label} — ${dialect} schema overview`,
    sourcePath: input.safeUrl,
    text: [
      `# ${label} — ${dialect} schema overview`,
      '',
      `${input.tables.length} tables and views, ${input.columns.length} columns.`,
      'Introspected live from the database. No row data was read.',
      '',
      '## Tables',
      '',
      markdownTable(['Object', 'Kind', 'Columns', 'Approx. rows', 'Comment'], tableRows),
      input.enums.length > 0
        ? [
            '',
            '## Enum types',
            '',
            markdownTable(
              ['Type', 'Values'],
              input.enums.map((entry) => [
                `\`${str(entry['schema_name'])}.${str(entry['enum_name'])}\``,
                str(entry['values']),
              ]),
            ),
          ].join('\n')
        : '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  });

  // ── One document per table ───────────────────────────────────────────────
  for (const table of input.tables) {
    const id = key(table.table_schema, table.table_name);
    const columns = columnsByTable.get(id) ?? [];
    if (columns.length === 0) continue;

    const constraints = constraintsByTable.get(id) ?? [];
    const primaryKeys = constraints
      .filter((constraint) => constraint.constraint_type === 'PRIMARY KEY' && constraint.column_name !== null)
      .map((constraint) => constraint.column_name as string);
    const foreignKeys = constraints.filter(
      (constraint) => constraint.constraint_type === 'FOREIGN KEY' && constraint.referenced_table !== null,
    );

    const columnRows = columns.map((column) => {
      const type =
        column.character_maximum_length !== null
          ? `${column.data_type}(${column.character_maximum_length})`
          : column.data_type;
      return [
        `\`${column.column_name}\``,
        type,
        column.is_nullable === 'YES' ? 'yes' : 'no',
        str(column.column_default).slice(0, 40) || '—',
        primaryKeys.includes(column.column_name) ? 'PK' : '',
        str(column.column_comment).slice(0, 90) || '—',
      ];
    });

    const { shown: indexList, omitted: indexOmitted } = capList(indexesByTable.get(id) ?? [], 12);

    documents.push({
      ...base,
      id: `svc-${slug(sourceRef)}-table-${slug(id)}`,
      title: `${label} — table ${id}`,
      sourcePath: `${input.safeUrl}#${id}`,
      tags: [...base.tags, 'table'],
      text: [
        `# ${id}`,
        '',
        str(table.table_comment).length > 0 ? `${table.table_comment}\n` : '',
        (() => {
          const kind = table.table_type.toLowerCase().includes('view') ? 'view' : 'table';
          const stem = `A ${kind} in the \`${label}\` ${dialect} database`;
          if (!input.includeRowCounts) return `${stem}.`;
          const rows = formatRowCount(table.estimated_rows);
          // Do not dress up a missing statistic as a measurement.
          return rows === 'unknown' ? `${stem}. Row count is not available.` : `${stem} with approximately ${rows} rows.`;
        })(),
        '',
        '## Columns',
        '',
        markdownTable(['Column', 'Type', 'Nullable', 'Default', 'Key', 'Comment'], columnRows),
        '',
        primaryKeys.length > 0 ? `## Primary key\n\n${primaryKeys.map((column) => `\`${column}\``).join(', ')}\n` : '',
        foreignKeys.length > 0
          ? [
              '## Foreign keys',
              '',
              ...foreignKeys.map(
                (constraint) =>
                  `- \`${constraint.column_name}\` → \`${constraint.referenced_table}.${constraint.referenced_column}\``,
              ),
              '',
            ].join('\n')
          : '',
        indexList.length > 0
          ? [
              '## Indexes',
              '',
              ...indexList.map((entry) => `- \`${entry}\``),
              indexOmitted > 0 ? `- _(${indexOmitted} more omitted)_` : '',
              '',
            ]
              .filter((line) => line !== '')
              .join('\n')
          : '',
      ]
        .filter((line) => line !== '')
        .join('\n'),
    });
  }

  return documents;
}

/**
 * `reltuples` is -1 until a table has been ANALYZEd, and 0 is indistinguishable
 * from "genuinely empty". Both are reported as unknown rather than invented.
 */
function formatRowCount(value: unknown): string {
  const count = num(value);
  if (count < 0) return 'unknown';
  if (count === 0) return 'unknown';
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 60);
}

export function sqlSource(options: SqlSourceOptions): DataSource {
  const safeUrl = redactUrl(options.url);
  const label = options.label ?? databaseNameFromUrl(options.url, options.dialect);
  const ref = `${options.dialect}:${label}`;

  return {
    kind: options.dialect,
    ref,
    label,

    async collect(context: SourceContext): Promise<SourceCollectResult> {
      context.onProgress?.({ stage: 'connect', detail: safeUrl });

      const raw = await withConnector(
        options.dialect,
        () => (options.dialect === 'postgres' ? runPostgres(options.url) : runMysql(options.url)),
        options.dialect === 'postgres'
          ? 'Check the connection URL, that the host is reachable, and that the role can read information_schema. Install the driver with `bun add postgres`.'
          : 'Check the connection URL and that the user can read information_schema. Install the driver with `bun add mysql2`.',
      );

      let tables = (raw['tables'] ?? []) as unknown as TableRow[];
      let columns = (raw['columns'] ?? []) as unknown as ColumnRow[];
      const constraints = (raw['constraints'] ?? []) as unknown as ConstraintRow[];

      if (options.schemas !== undefined && options.schemas.length > 0) {
        const allowed = new Set(options.schemas);
        tables = tables.filter((table) => allowed.has(table.table_schema));
        columns = columns.filter((column) => allowed.has(column.table_schema));
      }

      context.onProgress?.({ stage: 'document', detail: `${tables.length} tables` });

      const documents = buildDocuments({
        label,
        dialect: options.dialect,
        sourceRef: ref,
        safeUrl,
        tables,
        columns,
        constraints,
        indexes: raw['indexes'] ?? [],
        enums: raw['enums'] ?? [],
        includeRowCounts: options.includeRowCounts ?? true,
      });

      const warnings: string[] = [];
      if (tables.length === 0) {
        warnings.push('No tables were visible. The role may lack read access to information_schema, or the database is empty.');
      }

      log.info('sql schema collected', { dialect: options.dialect, label, tables: tables.length, documents: documents.length });

      return {
        documents,
        warnings,
        detectedServices: [],
        stats: {
          dialect: options.dialect,
          database: label,
          tables: tables.length,
          columns: columns.length,
          documents: documents.length,
        },
      };
    },
  };
}

/** Convenience wrappers so callers read declaratively. */
export const postgresSource = (options: Omit<SqlSourceOptions, 'dialect'>): DataSource =>
  sqlSource({ ...options, dialect: 'postgres' });

export const mysqlSource = (options: Omit<SqlSourceOptions, 'dialect'>): DataSource =>
  sqlSource({ ...options, dialect: 'mysql' });
