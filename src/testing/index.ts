/**
 * Test utilities, exported so consumers can test *their* pipelines the way this
 * repo tests its own: with a deterministic embedding model and no model server.
 */
export {
  createHashingEmbeddingModel,
  hashingEmbed,
  HASHING_EMBEDDING_DIMENSIONS,
} from './hashing-embedding';
export type { HashingEmbeddingModelOptions } from './hashing-embedding';

export {
  createHarness,
  assert,
  assertEqual,
  assertIncludes,
  assertThrows,
  AssertionError,
} from './assert';
export type { Harness } from './assert';
