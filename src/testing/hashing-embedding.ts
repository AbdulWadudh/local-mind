import type { EmbeddingModelV4 } from '@ai-sdk/provider';

/**
 * A deterministic, dependency-free, zero-network embedding model.
 *
 * WHY NOT JUST RETURN RANDOM VECTORS
 * A random or hash-of-the-whole-string embedding would let the harness prove the
 * plumbing works — vectors go in, rows come out — while telling you nothing about
 * whether retrieval retrieves the right thing. Ranking would be arbitrary, so a
 * test asserting "the chunk about cosine distance is the top hit" would be
 * meaningless.
 *
 * WHAT THIS IS INSTEAD
 * Signed feature hashing (the "hashing trick") over word tokens, with
 * sublinear term-frequency weighting and L2 normalisation. That is a real, if
 * primitive, lexical vector space: documents sharing vocabulary genuinely land
 * near each other, so cosine similarity is meaningful and the ranking assertions
 * in the harness test something.
 *
 * It has no semantic understanding at all — "car" and "automobile" are
 * orthogonal — which is precisely why it is a test fixture and not a fallback.
 * The point is that everything from the vector onward (LanceDB schema, cosine
 * distance, score conversion, thresholding, context assembly) is exercised for
 * real, with no model server and no nondeterminism.
 */

const DEFAULT_DIMENSIONS = 256;

/** FNV-1a, 32-bit. Small, fast, and stable across runs and platforms. */
function fnv1a(input: string, seed = 0x811c9dc5): number {
  let hash = seed;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    // hash * 16777619 with 32-bit wraparound
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .split(' ')
    .filter((token) => token.length > 1);
}

export function hashingEmbed(text: string, dimensions = DEFAULT_DIMENSIONS): number[] {
  const counts = new Map<string, number>();
  for (const token of tokenise(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  const vector = new Array<number>(dimensions).fill(0);

  for (const [token, count] of counts) {
    const bucket = fnv1a(token) % dimensions;
    // A second, differently-seeded hash decides the sign. Signed hashing makes
    // collisions cancel on average instead of always inflating a bucket.
    const sign = (fnv1a(token, 0x9e3779b1) & 1) === 0 ? 1 : -1;
    const weight = 1 + Math.log(count);
    const current = vector[bucket] ?? 0;
    vector[bucket] = current + sign * weight;
  }

  // L2 normalise so cosine similarity is a plain dot product and no document is
  // advantaged purely by length.
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  const magnitude = Math.sqrt(sumSquares);

  if (magnitude === 0) {
    // Empty/stopword-only input. A zero vector breaks cosine similarity, so emit
    // a fixed unit vector instead: deterministic, and never NaN downstream.
    vector[0] = 1;
    return vector;
  }

  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = (vector[index] ?? 0) / magnitude;
  }
  return vector;
}

export interface HashingEmbeddingModelOptions {
  readonly dimensions?: number;
  /** Counts calls, so the harness can assert batching actually batched. */
  readonly onEmbed?: (batchSize: number) => void;
}

/**
 * An `EmbeddingModel` the AI SDK will accept anywhere a real one is expected.
 * Implemented against the provider interface directly rather than via `ai/test`
 * so the harness does not depend on test-utility shapes.
 */
export function createHashingEmbeddingModel(options: HashingEmbeddingModelOptions = {}): EmbeddingModelV4 {
  const dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;

  return {
    specificationVersion: 'v4',
    provider: 'localmind-test',
    modelId: `hashing-${dimensions}`,
    // Deliberately small, so a 30-chunk corpus exercises the batching loop in
    // `embedChunks` rather than sending everything in one call.
    maxEmbeddingsPerCall: 8,
    supportsParallelCalls: true,
    doEmbed: ({ values }) => {
      options.onEmbed?.(values.length);
      return Promise.resolve({
        embeddings: values.map((value) => hashingEmbed(value, dimensions)),
        usage: { tokens: values.reduce((sum, value) => sum + tokenise(value).length, 0) },
        warnings: [],
      });
    },
  };
}

export const HASHING_EMBEDDING_DIMENSIONS = DEFAULT_DIMENSIONS;
