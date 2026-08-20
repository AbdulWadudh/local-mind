import type { LocalMindConfig } from '../core/config';
import { createLogger } from '../core/logger';
import { probeEmbeddingDimensions } from '../core/providers';
import type { ModelRegistry } from '../core/providers';
import type { IndexManifest, SourceDocument } from '../core/types';

import { chunkCorpus } from './chunker';
import { embedChunks } from './embedder';
import { readManifest, writeManifest } from '../store/manifest';
import { openDocumentStore } from '../store/document-store';
import { assertUniqueDocumentIds, loadCorpus } from './loader';
import { openVectorStore } from '../store/vector-store';

/**
 * The full ingestion pipeline: load -> chunk -> embed -> upsert -> manifest.
 *
 * Ordering is not arbitrary. The embedding dimension is probed *before* the
 * table is opened, because the Arrow schema needs it, and the manifest is
 * written *last*, after every row has landed. That ordering makes an
 * interrupted ingest safe to re-run: a missing manifest means "index not
 * finished", and merge-insert on the deterministic chunk id means re-running
 * costs only the work that was lost.
 */

const log = createLogger('ingest:pipeline');

export interface IngestOptions {
  readonly config: LocalMindConfig;
  readonly registry: ModelRegistry;
  /**
   * Documents to ingest. Omit to read `config.store.corpusDir` from disk.
   *
   * This is the integration seam: pass documents built with
   * `createSourceDocument()` to ingest from a database, an API, a CMS, or
   * extracted PDF text without touching the filesystem. Everything downstream -
   * chunking, deterministic ids, idempotent upsert, the manifest guard - behaves
   * identically either way.
   */
  readonly documents?: readonly SourceDocument[];
  readonly rebuild?: boolean;
  /** Delete rows for documents that no longer exist in the source set. */
  readonly prune?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (stage: string, done: number, total: number) => void;
}

export interface IngestReport {
  readonly documents: number;
  readonly chunks: number;
  readonly dimensions: number;
  readonly rowsUpserted: number;
  readonly rowsPruned: number;
  readonly totalRows: number;
  readonly durationMs: number;
  readonly chunkStats: {
    readonly meanTokens: number;
    readonly minTokens: number;
    readonly maxTokens: number;
  };
}

export async function ingestCorpus(options: IngestOptions): Promise<IngestReport> {
  const { config, registry } = options;
  const startedAt = Date.now();

  // 1. Load (or accept pre-built documents) ----------------------------------
  const documents = options.documents ?? (await loadCorpus({ corpusDir: config.store.corpusDir }));

  if (options.documents !== undefined) {
    // The filesystem enforces unique paths for us; a caller-supplied set has to
    // be checked, or duplicate ids silently overwrite each other on upsert.
    assertUniqueDocumentIds(documents);
    log.info('ingesting caller-supplied documents', { documents: documents.length });
  }

  // 2. Chunk -----------------------------------------------------------------
  const { chunks, stats } = chunkCorpus(documents, {
    maxChars: config.chunking.maxChars,
    overlapChars: config.chunking.overlapChars,
  });

  // 3. Probe dimensions BEFORE the table exists ------------------------------
  const dimensions = await probeEmbeddingDimensions(
    registry.embedding,
    options.signal !== undefined ? { signal: options.signal } : {},
  );

  // 4. Embed -----------------------------------------------------------------
  const embedded = await embedChunks(chunks, {
    model: registry.embedding,
    expectedDimensions: dimensions,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    onProgress: (done, total) => options.onProgress?.('embed', done, total),
  });

  // 5. Upsert ----------------------------------------------------------------
  const store = await openVectorStore({
    dbPath: config.store.dbPath,
    tableName: config.store.tableName,
    dimensions,
    createIfMissing: true,
    ...(options.rebuild === true ? { rebuild: true } : {}),
  });

  let rowsUpserted = 0;
  let rowsPruned = 0;
  let totalRows = 0;

  try {
    const batchSize = 256;
    for (let offset = 0; offset < embedded.length; offset += batchSize) {
      const batch = embedded.slice(offset, offset + batchSize);
      rowsUpserted += await store.upsert(batch);
      options.onProgress?.('upsert', rowsUpserted, embedded.length);
    }

    if (options.prune === true && options.rebuild !== true) {
      rowsPruned = await store.pruneDocuments(documents.map((document) => document.id));
    }

    totalRows = await store.countRows();
  } finally {
    await store.close();
  }

  // 5b. Record the documents themselves ---------------------------------------
  //
  // Chunks alone are enough for retrieval, and were all this pipeline wrote
  // originally. But the Studio lists, edits and deletes *documents*, and chunks
  // are lossy (overlap duplicates text) so a document cannot be reconstructed
  // from them. Writing both here is what keeps the CLI path and the Studio path
  // looking at the same corpus instead of two disagreeing views of it.
  const documentStore = await openDocumentStore({ dbPath: config.store.dbPath });
  try {
    const chunkCounts = new Map<string, number>();
    for (const chunk of embedded) {
      chunkCounts.set(chunk.documentId, (chunkCounts.get(chunk.documentId) ?? 0) + 1);
    }

    const now = new Date().toISOString();
    await documentStore.putMany(
      documents.map((document) => ({
        id: document.id,
        title: document.title,
        sourcePath: document.relativePath,
        origin: 'file' as const,
        text: document.text,
        contentHash: document.contentHash,
        tags: ['corpus'],
        sourceRef: `file:${config.store.corpusDir}`,
        chunkCount: chunkCounts.get(document.id) ?? 0,
        createdAt: now,
        updatedAt: now,
      })),
    );

    if (options.prune === true || options.rebuild === true) {
      // Drop document rows whose files are gone. Without this, deleting a file
      // and re-ingesting leaves an orphan row that the Studio would still list.
      const keep = new Set(documents.map((document) => document.id));
      for (const existingDocument of await documentStore.list({ limit: 100_000 })) {
        if (existingDocument.origin === 'file' && !keep.has(existingDocument.id)) {
          await documentStore.remove(existingDocument.id);
        }
      }
    }
  } finally {
    await documentStore.close();
  }

  // 6. Manifest last ---------------------------------------------------------
  const existing = await readManifest(config.store.dbPath);
  const now = new Date().toISOString();

  const manifest: IndexManifest = {
    manifestVersion: 1,
    embeddingProvider: config.embedding.provider,
    embeddingModel: config.embedding.model,
    dimensions,
    chunking: {
      maxChars: config.chunking.maxChars,
      overlapChars: config.chunking.overlapChars,
    },
    documentCount: documents.length,
    chunkCount: totalRows,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await writeManifest(config.store.dbPath, manifest);

  const report: IngestReport = {
    documents: documents.length,
    chunks: chunks.length,
    dimensions,
    rowsUpserted,
    rowsPruned,
    totalRows,
    durationMs: Date.now() - startedAt,
    chunkStats: {
      meanTokens: stats.meanTokens,
      minTokens: stats.minTokens,
      maxTokens: stats.maxTokens,
    },
  };

  log.info('ingest complete', { ...report, chunkStats: undefined });
  return report;
}
