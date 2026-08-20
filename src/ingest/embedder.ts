import { embed, embedMany } from 'ai';
import type { EmbeddingModel } from 'ai';

import { LocalMindError, describeUnknownError } from '../core/errors';
import { createLogger } from '../core/logger';
import { withRetry } from '../core/resilience';
import type { Chunk, EmbeddedChunk } from '../core/types';

/**
 * The embedding stage.
 *
 * `embedMany` already batches internally against each provider's per-request
 * limit, so why batch again here? Three reasons that only show up at real corpus
 * sizes:
 *
 *  1. Memory. A 20k-chunk corpus at 768 floats is ~60 MB of `number[]` before
 *     Arrow conversion. Streaming batches to the store keeps the peak bounded.
 *  2. Failure blast radius. A local Ollama server under memory pressure will
 *     drop a request. Retrying 64 chunks is cheap; retrying 20,000 is not.
 *  3. Progress. Embedding a corpus on CPU takes minutes. Silence for minutes is
 *     indistinguishable from a hang.
 */

const log = createLogger('ingest:embedder');

const DEFAULT_BATCH_SIZE = 64;

export interface EmbedChunksOptions {
  readonly model: EmbeddingModel;
  readonly batchSize?: number;
  readonly expectedDimensions?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (done: number, total: number) => void;
}

/** Reject vectors that would poison the index in ways cosine distance hides. */
function assertUsableVector(vector: readonly number[], dimensions: number, chunkId: string): void {
  if (vector.length !== dimensions) {
    throw new LocalMindError(
      'EMBEDDING_DIMENSION_MISMATCH',
      `Chunk ${chunkId} embedded to ${vector.length} dimensions, expected ${dimensions}.`,
      {
        remedy: 'A single model must produce every vector in a table. Re-run ingestion with --rebuild after changing LOCALMIND_EMBEDDING_MODEL.',
        details: { chunkId, got: vector.length, expected: dimensions },
      },
    );
  }

  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new LocalMindError('EMBEDDING_FAILED', `Chunk ${chunkId} produced a non-finite embedding value.`, {
        remedy: 'The provider returned NaN/Infinity. Re-pull the embedding model; a truncated GGUF download is the usual cause.',
        details: { chunkId },
      });
    }
  }

  // An all-zero vector has undefined cosine similarity. LanceDB will happily
  // store it and then return it for *every* query with distance NaN or 1.
  const magnitude = Math.hypot(...vector);
  if (magnitude === 0) {
    throw new LocalMindError('EMBEDDING_FAILED', `Chunk ${chunkId} produced a zero vector.`, {
      remedy: 'Zero vectors break cosine similarity. Check that the chunk text is not empty and that the model is an embedding model.',
      details: { chunkId },
    });
  }
}

/**
 * Embed every chunk, in batches, with retry. Returns chunks in input order with
 * their vector attached.
 */
export async function embedChunks(
  chunks: readonly Chunk[],
  options: EmbedChunksOptions,
): Promise<readonly EmbeddedChunk[]> {
  if (chunks.length === 0) return [];

  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const embedded: EmbeddedChunk[] = [];
  let dimensions = options.expectedDimensions;

  for (let offset = 0; offset < chunks.length; offset += batchSize) {
    const batch = chunks.slice(offset, offset + batchSize);

    const result = await withRetry(
      () =>
        embedMany({
          model: options.model,
          values: batch.map((chunk) => chunk.embedText),
          maxRetries: 1, // outer withRetry owns the backoff policy
          ...(options.signal !== undefined ? { abortSignal: options.signal } : {}),
        }),
      { label: `embedMany[${offset}..${offset + batch.length - 1}]`, attempts: 3 },
    );

    if (result.embeddings.length !== batch.length) {
      throw new LocalMindError(
        'EMBEDDING_FAILED',
        `Provider returned ${result.embeddings.length} embeddings for ${batch.length} inputs.`,
        {
          remedy: 'Embeddings are matched to chunks by position, so a length mismatch is unrecoverable. Reduce the batch size and retry.',
          details: { offset, expected: batch.length, got: result.embeddings.length },
        },
      );
    }

    for (const [index, chunk] of batch.entries()) {
      const vector = result.embeddings[index];
      if (vector === undefined) {
        throw new LocalMindError('EMBEDDING_FAILED', `Missing embedding at batch position ${index}.`, {
          remedy: 'Reduce LOCALMIND_CHUNK_CHARS or the batch size; some providers silently drop oversized inputs.',
          details: { chunkId: chunk.id, offset, index },
        });
      }

      dimensions ??= vector.length;
      assertUsableVector(vector, dimensions, chunk.id);
      embedded.push({ ...chunk, vector });
    }

    options.onProgress?.(embedded.length, chunks.length);
    log.debug('batch embedded', {
      done: embedded.length,
      total: chunks.length,
      tokens: result.usage?.tokens ?? 0,
    });
  }

  log.info('corpus embedded', { chunks: embedded.length, dimensions: dimensions ?? 0 });
  return embedded;
}

/**
 * Embed a single query.
 *
 * NOTE ON ASYMMETRY: the query is embedded raw, while chunks were embedded with
 * a "title > heading" prefix. That is intentional — the prefix moves the chunk
 * toward the topic region of the vector space, which is where topical queries
 * already live. Some models (E5, BGE, Nomic) additionally want an explicit
 * `search_query:` / `search_document:` prefix; if you switch to one, add it here
 * and in `Chunk.embedText`, and rebuild the index. Mixing prefixed and
 * unprefixed vectors in one table is silent quality loss, not an error.
 */
export async function embedQuery(
  query: string,
  options: { model: EmbeddingModel; signal?: AbortSignal },
): Promise<readonly number[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    throw new LocalMindError('EMBEDDING_FAILED', 'Refusing to embed an empty query.', {
      remedy: 'Pass a non-empty question.',
    });
  }

  try {
    const result = await withRetry(
      () =>
        embed({
          model: options.model,
          value: trimmed,
          maxRetries: 1,
          ...(options.signal !== undefined ? { abortSignal: options.signal } : {}),
        }),
      { label: 'embedQuery', attempts: 3 },
    );

    assertUsableVector(result.embedding, result.embedding.length, 'query');
    return result.embedding;
  } catch (error) {
    if (LocalMindError.is(error)) throw error;
    throw new LocalMindError('EMBEDDING_FAILED', `Failed to embed query: ${describeUnknownError(error)}`, {
      remedy: 'Run `bun run doctor` to confirm the embedding provider is reachable.',
      cause: error,
    });
  }
}
