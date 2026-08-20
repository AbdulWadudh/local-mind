import * as lancedb from '@lancedb/lancedb';
import { Field, FixedSizeList, Float32, Int32, Schema, Utf8 } from 'apache-arrow';

import { LocalMindError, describeUnknownError } from '../core/errors';
import { createLogger } from '../core/logger';
import type { EmbeddedChunk, RetrievedChunk } from '../core/types';

/**
 * The vector store: LanceDB, embedded, on-disk, no server, no API key.
 *
 * WHY AN EXPLICIT ARROW SCHEMA
 * LanceDB can infer a schema from the first batch of rows. Do not let it. Two
 * concrete failure modes:
 *
 *  - `FixedSizeList` vs `List`. Inference sees `number[]` and may produce a
 *    variable-length list, which cannot be vector-indexed. Search then silently
 *    degrades to a brute-force scan, or fails outright when you add an index.
 *  - Nullability and integer width. An inferred `chunkIndex` may land as
 *    Float64; you then cannot write a `WHERE chunkIndex = 3` predicate that
 *    matches. Declaring `Int32, non-null` up front makes filters behave.
 *
 * WHY COSINE AND NOT L2
 * Text embedding models are trained with cosine objectives, and their vectors
 * are not consistently unit-normalised across providers. L2 distance on
 * un-normalised vectors conflates "different topic" with "longer passage".
 * `distanceType("cosine")` compares direction only, which is what we want.
 * LanceDB returns `_distance = 1 - cosineSimilarity`, so score = 1 - distance.
 */

const log = createLogger('store:vector');

/**
 * Column list kept in one place: the schema, the row mapper and `select()` must
 * agree. `_distance` is listed explicitly because LanceDB currently injects it
 * into any projection that omits it, but warns that it will stop doing so.
 * Asking for it by name is both forward-compatible and self-documenting.
 */
const COLUMNS = [
  'id',
  'documentId',
  'title',
  'relativePath',
  'headingPath',
  'chunkIndex',
  'charStart',
  'charEnd',
  'tokenEstimate',
  'contentHash',
  'text',
] as const;

export function buildChunkSchema(dimensions: number): Schema {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new LocalMindError('VECTOR_STORE_FAILED', `Invalid embedding dimensions: ${dimensions}.`, {
      remedy: 'Dimensions come from `probeEmbeddingDimensions`; a non-positive value means the embedding call failed.',
    });
  }

  return new Schema([
    new Field('id', new Utf8(), false),
    new Field('documentId', new Utf8(), false),
    new Field('title', new Utf8(), false),
    new Field('relativePath', new Utf8(), false),
    new Field('headingPath', new Utf8(), true),
    new Field('chunkIndex', new Int32(), false),
    new Field('charStart', new Int32(), false),
    new Field('charEnd', new Int32(), false),
    new Field('tokenEstimate', new Int32(), false),
    new Field('contentHash', new Utf8(), false),
    new Field('text', new Utf8(), false),
    // `item` must be nullable: Arrow's canonical FixedSizeList child field is
    // nullable, and a non-nullable child makes schema comparison fail on reopen.
    new Field('vector', new FixedSizeList(dimensions, new Field('item', new Float32(), true)), false),
  ]);
}

interface ChunkRow {
  readonly id: string;
  readonly documentId: string;
  readonly title: string;
  readonly relativePath: string;
  readonly headingPath: string;
  readonly chunkIndex: number;
  readonly charStart: number;
  readonly charEnd: number;
  readonly tokenEstimate: number;
  readonly contentHash: string;
  readonly text: string;
  readonly vector: number[];
}

function toRow(chunk: EmbeddedChunk): ChunkRow {
  return {
    id: chunk.id,
    documentId: chunk.documentId,
    title: chunk.title,
    relativePath: chunk.relativePath,
    headingPath: chunk.headingPath,
    chunkIndex: chunk.chunkIndex,
    charStart: chunk.charStart,
    charEnd: chunk.charEnd,
    tokenEstimate: chunk.tokenEstimate,
    contentHash: chunk.contentHash,
    text: chunk.text,
    vector: [...chunk.vector],
  };
}

/** Read a string column defensively: Arrow may hand back a String object. */
function readString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

function readInt(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface SearchOptions {
  readonly topK: number;
  readonly minScore?: number;
  /** SQL predicate over the metadata columns, e.g. `relativePath = 'a/b.md'`. */
  readonly where?: string;
}

export interface VectorStore {
  readonly dimensions: number;
  upsert(chunks: readonly EmbeddedChunk[]): Promise<number>;
  search(vector: readonly number[], options: SearchOptions): Promise<readonly RetrievedChunk[]>;
  countRows(): Promise<number>;
  listSources(): Promise<readonly { title: string; relativePath: string; chunkCount: number }[]>;
  /** Delete rows whose documentId is no longer present in the corpus. */
  pruneDocuments(keepDocumentIds: readonly string[]): Promise<number>;
  /**
   * Delete every chunk belonging to one document.
   *
   * Required for edits, and easy to get wrong: chunk ids embed the document's
   * content hash, so editing a document produces a *different* set of ids.
   * Merge-insert therefore adds the new chunks without removing the old ones,
   * and the stale text stays retrievable forever. Every update path must delete
   * first, then upsert.
   */
  deleteDocument(documentId: string): Promise<number>;
  close(): Promise<void>;
}

export interface OpenStoreOptions {
  readonly dbPath: string;
  readonly tableName: string;
  readonly dimensions: number;
  /** Create the table if absent (ingest) vs fail loudly (query). */
  readonly createIfMissing: boolean;
  /** Drop and recreate the table before writing. */
  readonly rebuild?: boolean;
}

/** Escape a string literal for a LanceDB SQL predicate. */
function sqlString(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

export async function openVectorStore(options: OpenStoreOptions): Promise<VectorStore> {
  const { dbPath, tableName, dimensions } = options;

  let connection: lancedb.Connection;
  try {
    // `lancedb.connect` creates the directory itself, so no mkdir is needed -
    // which is also why there is no Bun equivalent to reach for here.
    connection = await lancedb.connect(dbPath);
  } catch (error) {
    throw new LocalMindError('VECTOR_STORE_FAILED', `Could not open LanceDB at "${dbPath}": ${describeUnknownError(error)}`, {
      remedy: 'Check that the path is writable and not held open by another process.',
      cause: error,
    });
  }

  let table: lancedb.Table;
  try {
    const existing = await connection.tableNames();
    const present = existing.includes(tableName);

    if (present && options.rebuild === true) {
      log.warn('dropping table for rebuild', { tableName });
      await connection.dropTable(tableName);
    }

    const stillPresent = present && options.rebuild !== true;

    if (stillPresent) {
      table = await connection.openTable(tableName);
      const schema = await table.schema();
      const vectorField = schema.fields.find((field) => field.name === 'vector');
      const listType = vectorField?.type as { listSize?: number } | undefined;
      const actual = listType?.listSize;

      if (typeof actual === 'number' && actual !== dimensions) {
        throw new LocalMindError(
          'EMBEDDING_DIMENSION_MISMATCH',
          `Table "${tableName}" stores ${actual}-dimension vectors but the configured model produces ${dimensions}.`,
          {
            remedy: 'Run `bun run ingest --rebuild` to recreate the table for the new model.',
            details: { tableName, tableDimensions: actual, modelDimensions: dimensions },
          },
        );
      }
    } else if (options.createIfMissing) {
      table = await connection.createEmptyTable(tableName, buildChunkSchema(dimensions), { mode: 'overwrite' });
      log.info('table created', { tableName, dimensions });
    } else {
      throw new LocalMindError('INDEX_MISSING', `No table "${tableName}" in "${dbPath}".`, {
        remedy: 'Build the index first: `bun run ingest`.',
        details: { dbPath, tableName, existingTables: existing },
      });
    }
  } catch (error) {
    connection.close();
    if (LocalMindError.is(error)) throw error;
    throw new LocalMindError('VECTOR_STORE_FAILED', `Could not open table "${tableName}": ${describeUnknownError(error)}`, {
      remedy: 'Delete the .data directory and re-ingest if the table is corrupt.',
      cause: error,
    });
  }

  /**
   * A LanceDB `Table` handle points at a dataset version. If another process
   * rebuilds the table - `localmind ingest --rebuild` while the Studio is
   * running is the obvious case - this handle keeps referencing data files that
   * no longer exist, and every subsequent call fails with a bare "Not found:
   * ....lance".
   *
   * `checkoutLatest()` re-points the handle at the current version. Doing it
   * lazily, on the specific error, costs nothing in the normal path and turns an
   * unrecoverable server into one that heals itself.
   */
  function isStaleHandleError(error: unknown): boolean {
    const message = describeUnknownError(error);
    return /Not found:.*\.lance|dataset (?:version|not found)|commit conflict|version .* not found/iu.test(message);
  }

  async function withRefresh<T>(label: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!isStaleHandleError(error)) throw error;
      log.warn('table changed underneath this handle; checking out latest', { label });
      await table.checkoutLatest();
      return operation();
    }
  }

  return {
    dimensions,

    async upsert(chunks): Promise<number> {
      if (chunks.length === 0) return 0;

      const rows = chunks.map(toRow);
      for (const row of rows) {
        if (row.vector.length !== dimensions) {
          throw new LocalMindError(
            'EMBEDDING_DIMENSION_MISMATCH',
            `Chunk ${row.id} has ${row.vector.length} dimensions, table expects ${dimensions}.`,
            { remedy: 'Re-run ingestion with --rebuild.', details: { chunkId: row.id } },
          );
        }
      }

      try {
        // Merge-insert on the deterministic chunk id makes re-ingestion
        // idempotent: unchanged chunks are updated in place instead of
        // duplicated, and an interrupted ingest can simply be re-run.
        await withRefresh('upsert', () =>
          table
            .mergeInsert('id')
            .whenMatchedUpdateAll()
            .whenNotMatchedInsertAll()
            .execute(rows as unknown as Record<string, unknown>[]),
        );

        log.debug('rows upserted', { count: rows.length });
        return rows.length;
      } catch (error) {
        throw new LocalMindError('VECTOR_STORE_FAILED', `Upsert failed: ${describeUnknownError(error)}`, {
          remedy: 'Reduce the ingest batch size, then retry. If the error persists, rebuild the table.',
          details: { rows: rows.length },
          cause: error,
        });
      }
    },

    async search(vector, searchOptions): Promise<readonly RetrievedChunk[]> {
      if (vector.length !== dimensions) {
        throw new LocalMindError(
          'EMBEDDING_DIMENSION_MISMATCH',
          `Query vector has ${vector.length} dimensions, table expects ${dimensions}.`,
          {
            remedy: 'The query was embedded with a different model than the index. Restore the original LOCALMIND_EMBEDDING_MODEL or rebuild the index.',
            details: { queryDimensions: vector.length, tableDimensions: dimensions },
          },
        );
      }

      const minScore = searchOptions.minScore ?? 0;

      let rows: Record<string, unknown>[];
      try {
        // `table.query().nearestTo(...)` rather than `table.search(...)`: the
        // latter is typed `VectorQuery | Query` because it also accepts
        // full-text queries, so `.distanceType()` is not statically available
        // on it. Going through `query()` keeps the chain fully typed.
        let query = table
          .query()
          .nearestTo([...vector])
          .distanceType('cosine')
          .select([...COLUMNS, '_distance'])
          .limit(Math.max(1, searchOptions.topK));

        if (searchOptions.where !== undefined && searchOptions.where.trim().length > 0) {
          query = query.where(searchOptions.where);
        }

        rows = await withRefresh('search', async () => (await query.toArray()) as Record<string, unknown>[]);
      } catch (error) {
        throw new LocalMindError('VECTOR_STORE_FAILED', `Vector search failed: ${describeUnknownError(error)}`, {
          remedy: 'If you passed a `where` filter, check it is valid SQL over the metadata columns.',
          details: { where: searchOptions.where ?? null },
          cause: error,
        });
      }

      const results: RetrievedChunk[] = [];
      for (const row of rows) {
        const rawDistance = row['_distance'];
        const distance = typeof rawDistance === 'number' ? rawDistance : Number.NaN;

        // A NaN distance means the row holds an unusable vector. Skipping is
        // correct: including it would let a garbage chunk outrank real evidence.
        if (!Number.isFinite(distance)) {
          log.warn('skipping row with non-finite distance', { id: readString(row, 'id') });
          continue;
        }

        const score = Math.min(1, Math.max(0, 1 - distance));
        if (score < minScore) continue;

        results.push({
          id: readString(row, 'id'),
          documentId: readString(row, 'documentId'),
          title: readString(row, 'title'),
          relativePath: readString(row, 'relativePath'),
          headingPath: readString(row, 'headingPath'),
          chunkIndex: readInt(row, 'chunkIndex'),
          text: readString(row, 'text'),
          tokenEstimate: readInt(row, 'tokenEstimate'),
          distance,
          score,
        });
      }

      return results;
    },

    async countRows(): Promise<number> {
      try {
        return await withRefresh('countRows', () => table.countRows());
      } catch (error) {
        throw new LocalMindError('VECTOR_STORE_FAILED', `countRows failed: ${describeUnknownError(error)}`, {
          remedy: 'The table may be mid-write. Retry, or rebuild the index.',
          cause: error,
        });
      }
    },

    async listSources(): Promise<readonly { title: string; relativePath: string; chunkCount: number }[]> {
      try {
        const rows = await withRefresh(
          'listSources',
          async () =>
            (await table.query().select(['title', 'relativePath']).limit(100_000).toArray()) as Record<
              string,
              unknown
            >[],
        );

        const grouped = new Map<string, { title: string; relativePath: string; chunkCount: number }>();
        for (const row of rows) {
          const relativePath = readString(row, 'relativePath');
          const entry = grouped.get(relativePath);
          if (entry === undefined) {
            grouped.set(relativePath, { title: readString(row, 'title'), relativePath, chunkCount: 1 });
          } else {
            entry.chunkCount += 1;
          }
        }

        return [...grouped.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      } catch (error) {
        throw new LocalMindError('VECTOR_STORE_FAILED', `listSources failed: ${describeUnknownError(error)}`, {
          remedy: 'Rebuild the index if the table is corrupt.',
          cause: error,
        });
      }
    },

    async deleteDocument(documentId): Promise<number> {
      try {
        const before = await withRefresh('deleteDocument', () => table.countRows());
        await withRefresh('deleteDocument', () => table.delete(`documentId = ${sqlString(documentId)}`));
        const after = await table.countRows();
        const removed = Math.max(0, before - after);
        log.debug('document chunks deleted', { documentId, removed });
        return removed;
      } catch (error) {
        throw new LocalMindError('VECTOR_STORE_FAILED', `Delete failed for document "${documentId}": ${describeUnknownError(error)}`, {
          remedy: 'Retry, or rebuild the index with `bun run ingest --rebuild`.',
          details: { documentId },
          cause: error,
        });
      }
    },

    async pruneDocuments(keepDocumentIds): Promise<number> {
      try {
        const before = await table.countRows();
        if (keepDocumentIds.length === 0) {
          await table.delete('true');
          return before;
        }
        const list = keepDocumentIds.map(sqlString).join(', ');
        await table.delete(`documentId NOT IN (${list})`);
        const after = await table.countRows();
        const removed = Math.max(0, before - after);
        if (removed > 0) log.info('pruned stale rows', { removed });
        return removed;
      } catch (error) {
        throw new LocalMindError('VECTOR_STORE_FAILED', `Prune failed: ${describeUnknownError(error)}`, {
          remedy: 'Run ingestion with --rebuild to recreate the table from scratch.',
          cause: error,
        });
      }
    },

    async close(): Promise<void> {
      // Synchronous in the native binding; wrapped in a promise so callers can
      // always `await store.close()` in a finally block.
      table.close();
      connection.close();
      return Promise.resolve();
    },
  };
}
