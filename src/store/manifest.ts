import { dirname, join } from 'node:path';

import { z } from 'zod';

import { LocalMindError, describeUnknownError } from '../core/errors';
import { readTextOrUndefined, writeText } from '../core/fs';
import { createLogger } from '../core/logger';
import type { IndexManifest } from '../core/types';

/**
 * The index manifest: a 200-byte JSON file that prevents the worst class of
 * local-RAG bug.
 *
 * THE BUG IT PREVENTS
 * You ingest with `nomic-embed-text` (768-dim). Later you set
 * LOCALMIND_EMBEDDING_MODEL=mxbai-embed-large (1024-dim) and run a query. Two
 * things can happen, and both are bad:
 *
 *   - Different dimensions: LanceDB rejects the query vector. Confusing error,
 *     but at least it *is* an error.
 *   - Same dimensions, different model: no error at all. The query vector lands
 *     in a completely unrelated region of a different vector space. Retrieval
 *     returns plausible-looking chunks that are semantically random, the model
 *     grounds an answer in them, and you ship a confident wrong answer.
 *
 * The second case is why this file exists. Comparing (provider, model,
 * dimensions) before every search turns a silent quality collapse into a loud,
 * actionable failure.
 */

const log = createLogger('store:manifest');

const MANIFEST_FILENAME = 'localmind-manifest.json';

const ManifestSchema = z.object({
  manifestVersion: z.literal(1),
  embeddingProvider: z.string().min(1),
  embeddingModel: z.string().min(1),
  dimensions: z.number().int().positive(),
  chunking: z.object({
    maxChars: z.number().int().positive(),
    overlapChars: z.number().int().min(0),
  }),
  documentCount: z.number().int().min(0),
  chunkCount: z.number().int().min(0),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export function manifestPath(dbPath: string): string {
  return join(dbPath, MANIFEST_FILENAME);
}

export async function readManifest(dbPath: string): Promise<IndexManifest | undefined> {
  const path = manifestPath(dbPath);
  const raw = await readTextOrUndefined(path);
  if (raw === undefined) return undefined;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new LocalMindError('INDEX_MANIFEST_MISMATCH', `Index manifest at ${path} is not valid JSON.`, {
      remedy: 'Delete the manifest and re-run `bun run ingest --rebuild`.',
      cause: error,
    });
  }

  const parsed = ManifestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new LocalMindError('INDEX_MANIFEST_MISMATCH', `Index manifest at ${path} does not match the expected shape.`, {
      remedy: 'This index was written by an incompatible version. Re-run `bun run ingest --rebuild`.',
      details: { issues: parsed.error.issues.map((issue) => issue.message) },
    });
  }

  return parsed.data;
}

export async function writeManifest(dbPath: string, manifest: IndexManifest): Promise<void> {
  const path = manifestPath(dbPath);
  try {
    // `Bun.write` creates missing parent directories, so no mkdir is needed.
    await writeText(path, `${JSON.stringify(manifest, null, 2)}\n`);
    log.debug('manifest written', { path, chunks: manifest.chunkCount, dimensions: manifest.dimensions });
  } catch (error) {
    throw new LocalMindError('VECTOR_STORE_FAILED', `Could not write index manifest: ${describeUnknownError(error)}`, {
      remedy: `Check write permissions for ${dirname(path)}.`,
      cause: error,
    });
  }
}

export interface ManifestExpectation {
  readonly embeddingProvider: string;
  readonly embeddingModel: string;
  readonly dimensions?: number;
}

/**
 * Assert that an existing index was built with the embedding configuration we
 * are about to query it with. Called by every read path.
 */
export function assertManifestCompatible(manifest: IndexManifest, expected: ManifestExpectation): void {
  const mismatches: string[] = [];

  if (manifest.embeddingProvider !== expected.embeddingProvider) {
    mismatches.push(`provider: index=${manifest.embeddingProvider} config=${expected.embeddingProvider}`);
  }
  if (manifest.embeddingModel !== expected.embeddingModel) {
    mismatches.push(`model: index=${manifest.embeddingModel} config=${expected.embeddingModel}`);
  }
  if (expected.dimensions !== undefined && manifest.dimensions !== expected.dimensions) {
    mismatches.push(`dimensions: index=${manifest.dimensions} config=${expected.dimensions}`);
  }

  if (mismatches.length === 0) return;

  throw new LocalMindError(
    'INDEX_MANIFEST_MISMATCH',
    `The index was built with a different embedding configuration (${mismatches.join('; ')}).`,
    {
      remedy: 'Either restore the original embedding settings, or rebuild the index: `bun run ingest --rebuild`. Querying across two vector spaces returns semantically random results without erroring.',
      details: {
        indexProvider: manifest.embeddingProvider,
        indexModel: manifest.embeddingModel,
        indexDimensions: manifest.dimensions,
      },
    },
  );
}
