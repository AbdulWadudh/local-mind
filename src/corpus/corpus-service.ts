import type { EmbeddingModel } from 'ai';

import type { LocalMindConfig } from '../core/config';
import { LocalMindError } from '../core/errors';
import { createLogger } from '../core/logger';
import { probeEmbeddingDimensions } from '../core/providers';
import type { SourceDocument } from '../core/types';
import { chunkDocument } from '../ingest/chunker';
import { createSourceDocument } from '../ingest/loader';
import { embedChunks } from '../ingest/embedder';
import { readManifest, writeManifest } from '../store/manifest';
import { openDocumentStore } from '../store/document-store';
import type { CorpusDocument, DocumentOrigin, DocumentQuery, DocumentStore } from '../store/document-store';
import { openVectorStore } from '../store/vector-store';
import type { VectorStore } from '../store/vector-store';

/**
 * The corpus service: the write side of the index.
 *
 * Retrieval only ever reads. Everything that *changes* the corpus goes through
 * here, because keeping two tables consistent is exactly the kind of thing that
 * works in testing and rots in production. Three invariants it enforces:
 *
 *  1. DELETE BEFORE UPSERT. Chunk ids embed the document's content hash, so
 *     editing a document produces a different set of ids. Merge-insert would add
 *     the new chunks and leave the old ones behind, and the stale text would stay
 *     retrievable forever. Every mutation deletes the document's chunks first.
 *
 *  2. ONE DIMENSION PER TABLE. The vector width is resolved once, from the
 *     manifest if an index already exists, and only probed from the model when
 *     bootstrapping. That prevents a mid-session model change from writing
 *     mismatched vectors into a live table.
 *
 *  3. THE MANIFEST FOLLOWS THE DATA. Counts are recomputed and rewritten after
 *     every mutation, so `chunkCount` in the manifest is never a stale claim.
 */

const log = createLogger('corpus');

export interface CorpusDocumentInput {
  /** Omit to derive a slug from the title. */
  readonly id?: string;
  readonly title: string;
  readonly text: string;
  readonly sourcePath?: string;
  readonly origin?: DocumentOrigin;
  readonly tags?: readonly string[];
  readonly sourceRef?: string;
}

export interface CorpusWriteResult {
  readonly document: CorpusDocument;
  readonly chunksWritten: number;
  readonly chunksRemoved: number;
  /** False when the text was unchanged and re-embedding was skipped. */
  readonly reembedded: boolean;
}

export interface CorpusStats {
  readonly documents: number;
  readonly chunks: number;
  readonly dimensions: number;
  readonly embeddingModel: string;
  readonly byOrigin: Readonly<Record<string, number>>;
  readonly updatedAt: string;
}

export interface CorpusService {
  list(query?: DocumentQuery): Promise<readonly CorpusDocument[]>;
  get(id: string): Promise<CorpusDocument | undefined>;
  /** Create or replace a document, re-chunking and re-embedding as needed. */
  put(input: CorpusDocumentInput): Promise<CorpusWriteResult>;
  putMany(inputs: readonly CorpusDocumentInput[]): Promise<readonly CorpusWriteResult[]>;
  remove(id: string): Promise<{ removed: boolean; chunksRemoved: number }>;
  removeBySourceRef(sourceRef: string): Promise<{ documents: number; chunksRemoved: number }>;
  /** Re-chunk and re-embed everything. Use after changing chunking settings. */
  reindex(onProgress?: (done: number, total: number) => void): Promise<{ documents: number; chunks: number }>;
  stats(): Promise<CorpusStats>;
  close(): Promise<void>;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 80);
  return slug.length > 0 ? slug : `doc-${Date.now().toString(36)}`;
}

export interface OpenCorpusServiceOptions {
  readonly config: LocalMindConfig;
  readonly embeddingModel: EmbeddingModel;
}

export async function openCorpusService(options: OpenCorpusServiceOptions): Promise<CorpusService> {
  const { config, embeddingModel } = options;

  // Invariant 2: prefer the manifest's dimension over probing the model. If an
  // index exists, its width is authoritative - probing could silently disagree.
  const existing = await readManifest(config.store.dbPath);
  const dimensions = existing?.dimensions ?? (await probeEmbeddingDimensions(embeddingModel));

  if (existing !== undefined && existing.embeddingModel !== config.embedding.model) {
    throw new LocalMindError(
      'INDEX_MANIFEST_MISMATCH',
      `The index was built with "${existing.embeddingModel}" but the configured model is "${config.embedding.model}".`,
      {
        remedy: 'Writing new vectors into a table built by a different model corrupts retrieval silently. Rebuild first: `bun run ingest --rebuild`.',
        details: { indexModel: existing.embeddingModel, configModel: config.embedding.model },
      },
    );
  }

  const documents: DocumentStore = await openDocumentStore({ dbPath: config.store.dbPath });
  const vectors: VectorStore = await openVectorStore({
    dbPath: config.store.dbPath,
    tableName: config.store.tableName,
    dimensions,
    createIfMissing: true,
  });

  async function syncManifest(): Promise<void> {
    const now = new Date().toISOString();
    const documentCount = await documents.count();
    const chunkCount = await vectors.countRows();
    const previous = await readManifest(config.store.dbPath);

    await writeManifest(config.store.dbPath, {
      manifestVersion: 1,
      embeddingProvider: config.embedding.provider,
      embeddingModel: config.embedding.model,
      dimensions,
      chunking: { maxChars: config.chunking.maxChars, overlapChars: config.chunking.overlapChars },
      documentCount,
      chunkCount,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    });
  }

  /** Chunk + embed + replace chunks for exactly one document. */
  async function writeChunks(source: SourceDocument): Promise<{ written: number; removed: number }> {
    // Invariant 1.
    const removed = await vectors.deleteDocument(source.id);

    const chunks = chunkDocument(source, {
      maxChars: config.chunking.maxChars,
      overlapChars: config.chunking.overlapChars,
    });

    const embedded = await embedChunks(chunks, { model: embeddingModel, expectedDimensions: dimensions });
    const written = await vectors.upsert(embedded);

    return { written, removed };
  }

  async function putOne(input: CorpusDocumentInput): Promise<CorpusWriteResult> {
    const id = input.id ?? slugify(input.title);
    const sourcePath = input.sourcePath ?? id;

    const source = createSourceDocument({
      id,
      text: input.text,
      title: input.title,
      sourcePath,
    });

    const previous = await documents.get(id);
    const now = new Date().toISOString();

    // Skip re-embedding when nothing that affects vectors changed. On a local CPU
    // embedding model this is the difference between an instant metadata edit and
    // a multi-second round trip.
    if (previous !== undefined && previous.contentHash === source.contentHash) {
      const document: CorpusDocument = {
        ...previous,
        title: input.title,
        sourcePath,
        origin: input.origin ?? previous.origin,
        tags: input.tags ?? previous.tags,
        sourceRef: input.sourceRef ?? previous.sourceRef,
        updatedAt: now,
      };
      await documents.put(document);
      log.debug('metadata-only update', { id });
      return { document, chunksWritten: 0, chunksRemoved: 0, reembedded: false };
    }

    const { written, removed } = await writeChunks(source);

    const document: CorpusDocument = {
      id,
      title: source.title,
      sourcePath,
      origin: input.origin ?? previous?.origin ?? 'manual',
      text: source.text,
      contentHash: source.contentHash,
      tags: input.tags ?? previous?.tags ?? [],
      sourceRef: input.sourceRef ?? previous?.sourceRef ?? '',
      chunkCount: written,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };

    await documents.put(document);
    log.info('document written', { id, chunks: written, replaced: removed });
    return { document, chunksWritten: written, chunksRemoved: removed, reembedded: true };
  }

  // Write the manifest on first open, not just on first mutation. Readers key
  // off its existence to decide whether an index exists at all, so an
  // initialised-but-empty corpus must still be openable for querying.
  if (existing === undefined) await syncManifest();

  return {
    list: (query) => documents.list(query),
    get: (id) => documents.get(id),

    async put(input): Promise<CorpusWriteResult> {
      const result = await putOne(input);
      await syncManifest();
      return result;
    },

    async putMany(inputs): Promise<readonly CorpusWriteResult[]> {
      const results: CorpusWriteResult[] = [];
      for (const input of inputs) results.push(await putOne(input));
      await syncManifest();
      return results;
    },

    async remove(id): Promise<{ removed: boolean; chunksRemoved: number }> {
      const chunksRemoved = await vectors.deleteDocument(id);
      const removed = await documents.remove(id);
      await syncManifest();
      log.info('document removed', { id, chunksRemoved });
      return { removed, chunksRemoved };
    },

    async removeBySourceRef(sourceRef): Promise<{ documents: number; chunksRemoved: number }> {
      const ids = await documents.removeBySourceRef(sourceRef);
      let chunksRemoved = 0;
      for (const id of ids) chunksRemoved += await vectors.deleteDocument(id);
      await syncManifest();
      return { documents: ids.length, chunksRemoved };
    },

    async reindex(onProgress): Promise<{ documents: number; chunks: number }> {
      const all = await documents.list({ limit: 100_000 });
      let chunks = 0;

      for (const [index, document] of all.entries()) {
        const source = createSourceDocument({
          id: document.id,
          text: document.text,
          title: document.title,
          sourcePath: document.sourcePath,
        });
        const { written } = await writeChunks(source);
        chunks += written;
        await documents.put({ ...document, chunkCount: written, updatedAt: new Date().toISOString() });
        onProgress?.(index + 1, all.length);
      }

      await syncManifest();
      log.info('reindex complete', { documents: all.length, chunks });
      return { documents: all.length, chunks };
    },

    async stats(): Promise<CorpusStats> {
      const all = await documents.list({ limit: 100_000 });
      const byOrigin: Record<string, number> = {};
      for (const document of all) byOrigin[document.origin] = (byOrigin[document.origin] ?? 0) + 1;

      const manifest = await readManifest(config.store.dbPath);
      return {
        documents: all.length,
        chunks: await vectors.countRows(),
        dimensions,
        embeddingModel: config.embedding.model,
        byOrigin,
        updatedAt: manifest?.updatedAt ?? new Date().toISOString(),
      };
    },

    async close(): Promise<void> {
      await documents.close();
      await vectors.close();
    },
  };
}
