import type { EmbeddingModel } from 'ai';

import type { LocalMindConfig } from '../core/config';
import { LocalMindError } from '../core/errors';
import { createLogger } from '../core/logger';
import type { RetrievalOptions, RetrievedChunk, Retriever } from '../core/types';

import { embedQuery } from '../ingest/embedder';
import { assertManifestCompatible, readManifest } from '../store/manifest';
import { openVectorStore } from '../store/vector-store';

/**
 * `Retriever` is the seam every later stage plugs into.
 *
 * Stage 2 calls it directly, Stage 3 wraps it in a `tool()`, and
 * Stage 4 calls it once per planned sub-query. Because it is an interface
 * rather than a concrete class, the offline test harness can substitute a
 * fixture-backed implementation and exercise the entire agent loop with no
 * model, no server and no disk I/O.
 */

const log = createLogger('retrieval');

export interface OpenRetrieverOptions {
  readonly config: LocalMindConfig;
  readonly embeddingModel: EmbeddingModel;
  /** Overrides the manifest check — only the ingest path should set this. */
  readonly skipManifestCheck?: boolean;
}

export async function openRetriever(options: OpenRetrieverOptions): Promise<Retriever> {
  const { config, embeddingModel } = options;

  const manifest = await readManifest(config.store.dbPath);
  if (manifest === undefined) {
    throw new LocalMindError('INDEX_MISSING', `No LocalMind index found at "${config.store.dbPath}".`, {
      remedy: 'Build it first: `bun run ingest`.',
      details: { dbPath: config.store.dbPath },
    });
  }

  if (options.skipManifestCheck !== true) {
    assertManifestCompatible(manifest, {
      embeddingProvider: config.embedding.provider,
      embeddingModel: config.embedding.model,
    });
  }

  const store = await openVectorStore({
    dbPath: config.store.dbPath,
    tableName: config.store.tableName,
    dimensions: manifest.dimensions,
    createIfMissing: false,
  });

  log.debug('retriever ready', {
    dimensions: manifest.dimensions,
    chunks: manifest.chunkCount,
    model: manifest.embeddingModel,
  });

  return {
    async search(query: string, searchOptions: RetrievalOptions = {}): Promise<readonly RetrievedChunk[]> {
      const topK = searchOptions.topK ?? config.retrieval.topK;
      const minScore = searchOptions.minScore ?? config.retrieval.minScore;

      const vector = await embedQuery(query, { model: embeddingModel });

      // Over-fetch, then threshold in application code. Doing it the other way
      // round (asking LanceDB for exactly topK and hoping they clear the bar)
      // means a single high-scoring chunk can crowd out the rest of the budget.
      const raw = await store.search(vector, {
        topK: Math.max(topK * 3, topK + 4),
        ...(searchOptions.where !== undefined ? { where: searchOptions.where } : {}),
      });

      const kept = raw.filter((chunk) => chunk.score >= minScore).slice(0, topK);

      log.debug('search complete', {
        query: query.slice(0, 80),
        candidates: raw.length,
        kept: kept.length,
        topScore: kept[0]?.score ?? 0,
        minScore,
      });

      return kept;
    },

    listSources: () => store.listSources(),
    close: () => store.close(),
  };
}
