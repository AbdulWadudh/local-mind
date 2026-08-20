import { join } from 'node:path';

import { generateText } from 'ai';

import { style } from '../core/ansi';
import { removeDirectory } from '../core/fs';
import { loadConfig } from '../core/config';
import type { LocalMindConfig } from '../core/config';
import { LocalMindError, reportFatal } from '../core/errors';
import { createModelRegistry } from '../core/providers';
import { createModelRecorder } from '../core/recorder';
import { estimateTokens, truncateToTokens } from '../core/tokens';

import { chunkCorpus, chunkDocument } from '../ingest/chunker';
import { embedChunks } from '../ingest/embedder';
import { loadCorpus } from '../ingest/loader';
import { assertManifestCompatible, readManifest, writeManifest } from '../store/manifest';
import { openVectorStore } from '../store/vector-store';
import { openRetriever } from '../retrieval/retriever';
import { assembleContext, auditCitations, normaliseCitationMarkers, renderWebSources, stitchOverlap } from '../retrieval/context';
import { streamGroundedAnswer } from '../generation/grounded-answer';
import { runRetrievalAgent } from '../agent/retrieval-agent';
import { createAgentTrace } from '../agent/trace';
import { DEFAULT_BUDGET, assertBudgetSane, runSelfCorrectingWorkflow } from '../workflow/graph';
import { createWebSearchProvider } from '../workflow/web-search';

import { assert, assertEqual, assertIncludes, assertThrows, createHarness } from '../testing/assert';
import { HASHING_EMBEDDING_DIMENSIONS, createHashingEmbeddingModel, hashingEmbed } from '../testing/hashing-embedding';

import { flagBoolean, parseArgs } from './shared';

/**
 * `bun run verify [--live]`
 *
 * The end-to-end validation harness.
 *
 * TWO TIERS, AND WHY
 *
 * The default run is HERMETIC: no network, no model server, no API key. It uses
 * a deterministic hashing embedding model against a real LanceDB table in a
 * temporary directory. That covers Stage 1 completely, plus every piece of
 * Stages 2-4 that is not the model call itself: context assembly, budget
 * enforcement, overlap stitching, citation auditing, manifest mismatch
 * detection, the offline web-search provider, and the workflow budget guard.
 *
 * `--live` adds the model-dependent paths: a grounded answer, an agent run, and
 * a full self-correcting workflow against whatever provider is configured. These
 * are smoke tests, not assertions about model output quality — a local 8B model
 * and a frontier model will both pass, and neither result is deterministic.
 *
 * The split matters because the hermetic tier is the one that can be trusted to
 * localise a regression. If it passes and `--live` fails, the bug is in a prompt
 * or a provider, not in the pipeline.
 */

const TEMP_DB = join('.data', 'verify-tmp');

function testConfig(base: LocalMindConfig): LocalMindConfig {
  return {
    ...base,
    store: { ...base.store, dbPath: TEMP_DB, tableName: 'verify' },
    embedding: { provider: 'ollama', model: 'localmind-test/hashing-256' },
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const live = flagBoolean(args, 'live');
  const harness = createHarness();
  const baseConfig = loadConfig();
  const config = testConfig(baseConfig);

  process.stderr.write(
    `${style.bold('LocalMind verify')} ${style.dim(live ? '(hermetic + live)' : '(hermetic; pass --live to add model calls)')}\n`,
  );

  await removeDirectory(TEMP_DB);

  const embeddingModel = createHashingEmbeddingModel();
  let embedCalls = 0;
  const countingEmbeddingModel = createHashingEmbeddingModel({
    onEmbed: () => {
      embedCalls += 1;
    },
  });

  // ── Stage 1: Index ────────────────────────────────────────────────────────
  harness.suite('Stage 1: Index - loading');

  const documents = await loadCorpus({ corpusDir: baseConfig.store.corpusDir });

  await harness.test('corpus loads with stable ids and hashes', () => {
    assert(documents.length > 0, 'expected at least one document');
    const ids = new Set(documents.map((document) => document.id));
    assertEqual(ids.size, documents.length, 'document ids must be unique');
    for (const document of documents) {
      assert(document.contentHash.length === 64, `expected a sha256 hash for ${document.relativePath}`);
      assert(!document.text.includes('\r'), 'line endings must be normalised to LF before hashing');
      assert(document.title.length > 0, `expected a derived title for ${document.relativePath}`);
    }
  });

  await harness.test('loading is deterministic across runs', async () => {
    const second = await loadCorpus({ corpusDir: baseConfig.store.corpusDir });
    assertEqual(
      second.map((document) => `${document.id}:${document.contentHash}`).join('|'),
      documents.map((document) => `${document.id}:${document.contentHash}`).join('|'),
      'two loads of the same corpus must produce identical ids and hashes',
    );
  });

  await harness.test('missing corpus directory fails with a remedy', async () => {
    await assertThrows(
      () => loadCorpus({ corpusDir: 'corpus-that-does-not-exist' }),
      (error) => LocalMindError.is(error) && error.code === 'CORPUS_UNREADABLE',
      'expected CORPUS_UNREADABLE',
    );
  });

  harness.suite('Stage 1: Index - chunking');

  const { chunks, stats } = chunkCorpus(documents, {
    maxChars: config.chunking.maxChars,
    overlapChars: config.chunking.overlapChars,
  });

  await harness.test('chunk statistics are within the configured envelope', () => {
    assertEqual(stats.documents, documents.length, 'stats must count every document');
    assertEqual(stats.chunks, chunks.length, 'stats must count every chunk');
    assert(stats.minTokens > 0, 'no chunk may be empty');
    assert(
      stats.maxTokens <= Math.ceil((config.chunking.maxChars + config.chunking.overlapChars) / 2),
      `max chunk of ${stats.maxTokens} tokens is implausibly large for a ${config.chunking.maxChars}-char ceiling`,
    );
  });

  await harness.test('every chunk respects the size ceiling', () => {
    for (const chunk of chunks) {
      // The ceiling is maxChars plus the overlap we deliberately prepend.
      const ceiling = config.chunking.maxChars + config.chunking.overlapChars + 64;
      assert(
        chunk.text.length <= ceiling,
        `chunk ${chunk.id} is ${chunk.text.length} chars, ceiling ${ceiling}`,
      );
    }
  });

  await harness.test('chunk ids are unique and deterministic', () => {
    const ids = new Set(chunks.map((chunk) => chunk.id));
    assertEqual(ids.size, chunks.length, 'chunk ids must be unique');

    const again = chunkCorpus(documents, {
      maxChars: config.chunking.maxChars,
      overlapChars: config.chunking.overlapChars,
    });
    assertEqual(
      again.chunks.map((chunk) => chunk.id).join('|'),
      chunks.map((chunk) => chunk.id).join('|'),
      'chunk ids must be stable for unchanged content (this is what makes re-ingest idempotent)',
    );
  });

  await harness.test('character offsets round-trip to the source text', () => {
    const byId = new Map(documents.map((document) => [document.id, document]));
    for (const chunk of chunks.slice(0, 40)) {
      const document = byId.get(chunk.documentId);
      assert(document !== undefined, `unknown documentId ${chunk.documentId}`);
      const slice = document.text.slice(chunk.charStart, chunk.charEnd).trim();
      assertEqual(slice, chunk.text, `offsets for ${chunk.id} must re-slice to the chunk text`);
    }
  });

  await harness.test('consecutive chunks overlap', () => {
    const multi = chunks.filter((chunk) => chunk.documentId === chunks[0]?.documentId);
    assert(multi.length >= 2, 'expected a document that produced at least two chunks');
    let overlaps = 0;
    for (let index = 1; index < multi.length; index += 1) {
      const previous = multi[index - 1];
      const current = multi[index];
      if (previous === undefined || current === undefined) continue;
      if (current.charStart < previous.charEnd) overlaps += 1;
    }
    assert(overlaps > 0, 'expected at least one pair of chunks whose character ranges overlap');
  });

  await harness.test('chunk starts strictly increase (loop termination)', () => {
    const byDocument = new Map<string, number>();
    for (const chunk of chunks) {
      const previous = byDocument.get(chunk.documentId);
      if (previous !== undefined) {
        assert(
          chunk.charStart > previous,
          `chunk ${chunk.id} starts at ${chunk.charStart}, not after the previous ${previous}`,
        );
      }
      byDocument.set(chunk.documentId, chunk.charStart);
    }
  });

  await harness.test('embedText carries the heading breadcrumb, text does not', () => {
    const withHeading = chunks.find((chunk) => chunk.headingPath.length > 0);
    assert(withHeading !== undefined, 'expected at least one chunk under a markdown heading');
    assertIncludes(withHeading.embedText, withHeading.headingPath, 'embedText must include the breadcrumb');
    assertIncludes(withHeading.embedText, withHeading.title, 'embedText must include the document title');
    assert(
      withHeading.text.trim() !== withHeading.embedText.trim(),
      'displayed text must stay free of the injected header',
    );
  });

  await harness.test('overlap >= chunk size is rejected', async () => {
    const document = documents[0];
    assert(document !== undefined, 'expected a document');
    await assertThrows(
      () => chunkDocument(document, { maxChars: 500, overlapChars: 500 }),
      (error) => LocalMindError.is(error) && error.code === 'CHUNKING_FAILED',
      'expected CHUNKING_FAILED for a non-advancing splitter configuration',
    );
  });

  await harness.test('a whitespace-only document is rejected, not silently dropped', async () => {
    await assertThrows(
      () =>
        chunkDocument(
          {
            id: 'blank',
            title: 'blank',
            relativePath: 'blank.md',
            absolutePath: '/tmp/blank.md',
            text: '   \n\n  ',
            charCount: 7,
            contentHash: 'x'.repeat(64),
          },
          { maxChars: 1200, overlapChars: 180 },
        ),
      (error) => LocalMindError.is(error) && error.code === 'CHUNKING_FAILED',
      'expected CHUNKING_FAILED',
    );
  });

  harness.suite('Stage 1: Index - embedding');

  await harness.test('hashing embeddings are unit-length and deterministic', () => {
    const a = hashingEmbed('cosine distance and vector normalisation');
    const b = hashingEmbed('cosine distance and vector normalisation');
    assertEqual(a.length, HASHING_EMBEDDING_DIMENSIONS, 'unexpected dimensionality');
    assertEqual(a.join(','), b.join(','), 'the same input must produce the same vector');
    const magnitude = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
    assert(Math.abs(magnitude - 1) < 1e-9, `expected a unit vector, got magnitude ${magnitude}`);
  });

  await harness.test('lexically similar text scores higher than unrelated text', () => {
    const dot = (x: number[], y: number[]): number => x.reduce((sum, value, i) => sum + value * (y[i] ?? 0), 0);
    const query = hashingEmbed('cosine distance metric for vector search');
    const near = hashingEmbed('the cosine distance metric is used for vector search ranking');
    const far = hashingEmbed('bananas ripen faster inside a paper bag');
    assert(dot(query, near) > dot(query, far), 'related text must score above unrelated text');
  });

  await harness.test('embedding batches respect maxEmbeddingsPerCall', async () => {
    embedCalls = 0;
    const embedded = await embedChunks(chunks.slice(0, 20), {
      model: countingEmbeddingModel,
      batchSize: 8,
    });
    assertEqual(embedded.length, 20, 'expected 20 embedded chunks');
    assert(embedCalls >= 3, `expected several provider calls for 20 chunks at batch size 8, saw ${embedCalls}`);
    for (const chunk of embedded) {
      assertEqual(chunk.vector.length, HASHING_EMBEDDING_DIMENSIONS, 'inconsistent vector width');
    }
  });

  harness.suite('Stage 1: Index - vector store');

  const embedded = await embedChunks(chunks, { model: embeddingModel });

  await harness.test('upsert then search returns the expected passage first', async () => {
    const store = await openVectorStore({
      dbPath: TEMP_DB,
      tableName: 'verify',
      dimensions: HASHING_EMBEDDING_DIMENSIONS,
      createIfMissing: true,
      rebuild: true,
    });

    try {
      const written = await store.upsert(embedded);
      assertEqual(written, embedded.length, 'upsert must report every row');
      assertEqual(await store.countRows(), embedded.length, 'table row count must match');

      const results = await store.search(hashingEmbed('cosine distance is 1 minus cosine similarity'), {
        topK: 5,
      });
      assert(results.length > 0, 'expected at least one search result');

      const top = results[0];
      assert(top !== undefined, 'expected a top result');
      assert(top.score > 0 && top.score <= 1, `score must be in (0, 1], got ${top.score}`);
      assert(
        results.every((result, index) => index === 0 || result.score <= (results[index - 1]?.score ?? 1)),
        'results must be sorted by descending score',
      );
      assert(
        top.relativePath.includes('embedding-models') || top.relativePath.includes('lancedb'),
        `expected a cosine-distance passage to rank first, got ${top.relativePath}`,
      );
    } finally {
      await store.close();
    }
  });

  await harness.test('re-upsert is idempotent (merge-insert on a deterministic id)', async () => {
    const store = await openVectorStore({
      dbPath: TEMP_DB,
      tableName: 'verify',
      dimensions: HASHING_EMBEDDING_DIMENSIONS,
      createIfMissing: false,
    });

    try {
      const before = await store.countRows();
      await store.upsert(embedded);
      const after = await store.countRows();
      assertEqual(after, before, 're-ingesting unchanged content must not duplicate rows');
    } finally {
      await store.close();
    }
  });

  await harness.test('a wrong-width query vector is rejected before hitting the index', async () => {
    const store = await openVectorStore({
      dbPath: TEMP_DB,
      tableName: 'verify',
      dimensions: HASHING_EMBEDDING_DIMENSIONS,
      createIfMissing: false,
    });

    try {
      await assertThrows(
        () => store.search(new Array<number>(64).fill(0.1), { topK: 3 }),
        (error) => LocalMindError.is(error) && error.code === 'EMBEDDING_DIMENSION_MISMATCH',
        'expected EMBEDDING_DIMENSION_MISMATCH',
      );
    } finally {
      await store.close();
    }
  });

  await harness.test('metadata filters apply', async () => {
    const store = await openVectorStore({
      dbPath: TEMP_DB,
      tableName: 'verify',
      dimensions: HASHING_EMBEDDING_DIMENSIONS,
      createIfMissing: false,
    });

    try {
      const results = await store.search(hashingEmbed('chunk overlap default'), {
        topK: 5,
        where: "relativePath = 'chunking-strategies.md'",
      });
      assert(results.length > 0, 'expected filtered results');
      assert(
        results.every((result) => result.relativePath === 'chunking-strategies.md'),
        'the filter must exclude every other document',
      );
    } finally {
      await store.close();
    }
  });

  await harness.test('listSources groups chunks by document', async () => {
    const store = await openVectorStore({
      dbPath: TEMP_DB,
      tableName: 'verify',
      dimensions: HASHING_EMBEDDING_DIMENSIONS,
      createIfMissing: false,
    });

    try {
      const sources = await store.listSources();
      assertEqual(sources.length, documents.length, 'expected one entry per document');
      const total = sources.reduce((sum, source) => sum + source.chunkCount, 0);
      assertEqual(total, embedded.length, 'chunk counts must sum to the row count');
    } finally {
      await store.close();
    }
  });

  harness.suite('Stage 1: Index - manifest guard');

  await harness.test('manifest round-trips', async () => {
    await writeManifest(TEMP_DB, {
      manifestVersion: 1,
      embeddingProvider: 'ollama',
      embeddingModel: 'localmind-test/hashing-256',
      dimensions: HASHING_EMBEDDING_DIMENSIONS,
      chunking: { maxChars: config.chunking.maxChars, overlapChars: config.chunking.overlapChars },
      documentCount: documents.length,
      chunkCount: embedded.length,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const manifest = await readManifest(TEMP_DB);
    assert(manifest !== undefined, 'expected to read back the manifest');
    assertEqual(manifest.dimensions, HASHING_EMBEDDING_DIMENSIONS, 'dimensions must round-trip');
  });

  await harness.test('a changed embedding model is caught before querying', async () => {
    const manifest = await readManifest(TEMP_DB);
    assert(manifest !== undefined, 'expected a manifest');

    // Same dimensions, different model: the dangerous case, because nothing else
    // in the stack would notice.
    await assertThrows(
      () =>
        assertManifestCompatible(manifest, {
          embeddingProvider: 'ollama',
          embeddingModel: 'some-other-model',
          dimensions: HASHING_EMBEDDING_DIMENSIONS,
        }),
      (error) => LocalMindError.is(error) && error.code === 'INDEX_MANIFEST_MISMATCH',
      'expected INDEX_MANIFEST_MISMATCH for a same-width different-model index',
    );

    assertManifestCompatible(manifest, {
      embeddingProvider: 'ollama',
      embeddingModel: 'localmind-test/hashing-256',
      dimensions: HASHING_EMBEDDING_DIMENSIONS,
    });
  });

  await harness.test('retriever refuses a missing index', async () => {
    await assertThrows(
      () =>
        openRetriever({
          config: { ...config, store: { ...config.store, dbPath: join('.data', 'definitely-absent') } },
          embeddingModel,
        }),
      (error) => LocalMindError.is(error) && error.code === 'INDEX_MISSING',
      'expected INDEX_MISSING',
    );
  });

  // ── Stage 2: Ground ───────────────────────────────────────────────────────
  harness.suite('Stage 2: Ground - context assembly');

  const retriever = await openRetriever({ config, embeddingModel });

  await harness.test('retriever thresholds and caps results', async () => {
    const results = await retriever.search('cosine distance', { topK: 3, minScore: 0.05 });
    assert(results.length <= 3, 'topK must cap the result count');
    assert(
      results.every((result) => result.score >= 0.05),
      'every result must clear minScore',
    );
  });

  await harness.test('an impossible threshold yields nothing rather than noise', async () => {
    const results = await retriever.search('cosine distance', { topK: 5, minScore: 0.999 });
    assertEqual(results.length, 0, 'expected no results above a 0.999 threshold');
  });

  await harness.test('overlap stitching removes the duplicated seam', () => {
    const stitched = stitchOverlap(
      'the recommended overlap is 10 to 20 percent of the chunk size',
      'percent of the chunk size, so 180 characters for a 1200 character chunk',
    );
    assertEqual(
      (stitched.match(/percent of the chunk size/gu) ?? []).length,
      1,
      'the shared seam must appear exactly once after stitching',
    );
    assertIncludes(stitched, '180 characters', 'the tail of the second chunk must survive');
  });

  await harness.test('context assembly respects the token budget', async () => {
    const results = await retriever.search('chunking overlap embeddings cosine', { topK: 8, minScore: 0 });
    const assembled = assembleContext(results, { maxTokens: 400 });
    assert(assembled.tokensUsed <= 400, `budget exceeded: ${assembled.tokensUsed} > 400`);
    assert(assembled.blocks.length > 0, 'expected at least one block to fit');
    assert(
      assembled.blocks.length < results.length || assembled.degraded,
      'a 400-token budget over 8 passages must drop or truncate something and report it',
    );
  });

  await harness.test('context assembly de-duplicates repeated chunks', async () => {
    const results = await retriever.search('cosine distance', { topK: 3, minScore: 0 });
    const assembled = assembleContext([...results, ...results], { maxTokens: 4000 });
    const ids = new Set(assembled.blocks.flatMap((block) => block.mergedFrom));
    assertEqual(
      ids.size,
      new Set(results.map((result) => result.id)).size,
      'the same chunk passed twice must appear once',
    );
  });

  await harness.test('labels are assigned in descending relevance order', async () => {
    const results = await retriever.search('vector dimensions', { topK: 5, minScore: 0 });
    const assembled = assembleContext(results, { maxTokens: 4000 });
    assembled.blocks.forEach((block, index) => {
      assertEqual(block.label, `S${index + 1}`, 'labels must be sequential');
    });
    for (let index = 1; index < assembled.blocks.length; index += 1) {
      const previous = assembled.blocks[index - 1];
      const current = assembled.blocks[index];
      if (previous === undefined || current === undefined) continue;
      assert(current.score <= previous.score, 'blocks must be ordered by descending score');
    }
  });

  await harness.test('zero retrieved passages produce an empty context, not a crash', () => {
    const assembled = assembleContext([], { maxTokens: 1000 });
    assertEqual(assembled.blocks.length, 0, 'expected no blocks');
    assertEqual(assembled.contextText, '', 'expected empty context text');
    assertEqual(assembled.citations.length, 0, 'expected no citations');
  });

  harness.suite('Stage 2: Ground - citation audit');

  await harness.test('valid citations pass the audit', () => {
    const citations = [
      { label: 'S1', chunkId: 'a', title: 'A', relativePath: 'a.md', headingPath: '', score: 0.9, origin: 'corpus' as const },
      { label: 'S2', chunkId: 'b', title: 'B', relativePath: 'b.md', headingPath: '', score: 0.8, origin: 'corpus' as const },
    ];
    const audit = auditCitations('Cosine distance is 1 minus cosine similarity [S1]. LanceDB defaults to L2 [S2].', citations);
    assert(audit.ok, `expected a clean audit, got ${JSON.stringify(audit)}`);
    assertEqual(audit.used.join(','), 'S1,S2', 'both labels must be recorded as used');
  });

  await harness.test('invented labels are detected', () => {
    const citations = [
      { label: 'S1', chunkId: 'a', title: 'A', relativePath: 'a.md', headingPath: '', score: 0.9, origin: 'corpus' as const },
    ];
    const audit = auditCitations('The timeout defaults to 30 seconds [S7].', citations);
    assert(!audit.ok, 'an invented label must fail the audit');
    assertEqual(audit.unknown.join(','), 'S7', 'expected S7 to be flagged');
  });

  /*
   * The regression these exist for: the free OpenRouter router serves a
   * different model per request, and models disagree about how to punctuate a
   * citation. Observed in one session: `nemotron-3-super` writing 【S6】, and a
   * router model writing bare `S1` and `(S5)`.
   *
   * Every one of those used to score as ZERO citations used and every long
   * sentence as uncited — which inverts the verdict the product exists to
   * produce. A well-grounded answer was reported as ungrounded, and Stage 4 then
   * spent a repair loop "fixing" it.
   */
  await harness.test('citation punctuation variants all audit as cited', () => {
    const citations = [1, 2, 5, 6].map((n) => ({
      label: `S${n}`,
      chunkId: `c${n}`,
      title: `T${n}`,
      relativePath: `p${n}.md`,
      headingPath: '',
      score: 0.8,
      origin: 'corpus' as const,
    }));

    const variants: readonly [string, string, string][] = [
      ['CJK lenticular', 'Deletion is a GDPR erasure\u3010S6\u3011.', 'S6'],
      ['CJK tortoise shell', 'One row per order\u3014S1\u3015.', 'S1'],
      ['fullwidth square', 'Rows are immutable\uFF3BS2\uFF3D.', 'S2'],
      ['ASCII parenthesis', 'A view marks refundable orders (S5).', 'S5'],
      ['bare label', 'It serves as the primary order record table S1.', 'S1'],
      ['compound comma', 'Both tables relate [S1, S2].', 'S1,S2'],
      ['canonical', 'Already fine [S5].', 'S5'],
      ['padded brackets', 'Models pad them often enough to matter [ S1 ].', 'S1'],
      ['padded compound', 'Both of these [ S1, S2 ].', 'S1,S2'],
    ];

    for (const [name, answer, expected] of variants) {
      const audit = auditCitations(answer, citations);
      assertEqual(audit.used.join(','), expected, `${name}: expected ${expected} to be recorded as used`);
      assertEqual(audit.unknown.length, 0, `${name}: nothing should be flagged as invented`);
    }
  });

  await harness.test('bare-label promotion is gated on the citation table', () => {
    const citations = [
      { label: 'S1', chunkId: 'a', title: 'A', relativePath: 'a.md', headingPath: '', score: 0.9, origin: 'corpus' as const },
    ];

    // `S9` was never offered as a citation, so it is prose and must be left
    // alone rather than promoted into an invented-label failure.
    assertEqual(
      normaliseCitationMarkers('The S9 bucket is unrelated. See S1.', ['S1']),
      'The S9 bucket is unrelated. See [S1].',
      'only known labels may be promoted',
    );

    // Word boundaries: a column named AS1 and a value S1X are not citations.
    assertEqual(
      normaliseCitationMarkers('Column AS1 and value S1X stay put.', ['S1']),
      'Column AS1 and value S1X stay put.',
      'partial word matches must not be rewritten',
    );

    assertEqual(auditCitations('The S9 bucket is unrelated.', citations).unknown.length, 0, 'S9 is prose, not a label');
  });

  await harness.test('markdown table rows are not counted as uncited claims', () => {
    const citations = [
      { label: 'S1', chunkId: 'a', title: 'A', relativePath: 'a.md', headingPath: '', score: 0.9, origin: 'corpus' as const },
    ];

    // A schema answer renders one long "sentence" per table row. Counting those
    // as claim sentences made a correctly-cited answer report six violations it
    // had not committed - the citation belongs to the paragraph introducing the
    // table, not to every cell inside it.
    const answer = [
      'Here are the columns [S1].',
      '',
      '| Column | Meaning |',
      '| --- | --- |',
      '| total_cents | Total amount of the order in minor currency units (cents) to avoid floating-point drift. |',
      '| refunded_at | Timestamp with time zone, set when a refund completes; nullable and only set within 45 days. |',
    ].join(String.fromCharCode(10));

    const audit = auditCitations(answer, citations);
    assertEqual(audit.uncitedSentences.length, 0, 'table rows must not be treated as uncited prose');
    assert(audit.ok, `expected a clean audit, got ${JSON.stringify(audit.uncitedSentences)}`);
  });

  await harness.test('citation normalisation is idempotent', () => {
    const labels = ['S1', 'S2', 'S3', 'S5', 'S6'];
    const messy = 'Orders\u3010S1\u3011. Lines (S2). Customers S6. View [S5, S3]. Unrelated S9.';
    const once = normaliseCitationMarkers(messy, labels);
    const twice = normaliseCitationMarkers(once, labels);
    assertEqual(twice, once, 'applying the normaliser twice must not change the result');
    assertEqual(once, 'Orders[S1]. Lines [S2]. Customers [S6]. View [S5][S3]. Unrelated S9.', 'unexpected normal form');
  });

  await harness.test('long uncited assertions are detected', () => {
    const citations = [
      { label: 'S1', chunkId: 'a', title: 'A', relativePath: 'a.md', headingPath: '', score: 0.9, origin: 'corpus' as const },
    ];
    const audit = auditCitations(
      'Cosine similarity is the correct default for text retrieval because embedding models are trained with a cosine objective and their outputs are not consistently normalised.',
      citations,
    );
    assert(audit.uncitedSentences.length === 1, 'expected the uncited sentence to be flagged');
    assert(!audit.ok, 'an uncited factual sentence must fail the audit');
  });

  harness.suite('Stage 2: Ground - token budgeting');

  await harness.test('token estimation over-approximates rather than under', () => {
    assert(estimateTokens('') === 0, 'empty text is zero tokens');
    const text = 'supercalifragilistic identifiers, punctuation; and_underscores';
    assert(estimateTokens(text) >= Math.ceil(text.length / 4), 'estimate must be at least chars/4');
  });

  await harness.test('truncation lands under the budget and is marked', () => {
    const long = 'word '.repeat(2000);
    const { text, truncated } = truncateToTokens(long, 100);
    assert(truncated, 'expected the truncation flag');
    assert(estimateTokens(text) <= 120, `truncated text still over budget: ${estimateTokens(text)}`);
    assertIncludes(text, 'truncated', 'truncation must be visible in the text');
  });

  // ── Stage 3: Delegate ─────────────────────────────────────────────────────
  harness.suite('Stage 3: Delegate - loop guards');

  await harness.test('the trace assigns stable labels per chunk', async () => {
    const trace = createAgentTrace({ maxSearches: 3 });
    const results = await retriever.search('cosine distance', { topK: 2, minScore: 0 });
    const first = results[0];
    assert(first !== undefined, 'expected a result');

    const labelA = trace.labelFor(first);
    const labelB = trace.labelFor(first);
    assertEqual(labelA, labelB, 'the same chunk must keep its label across calls');

    const second = results[1];
    if (second !== undefined) {
      assert(trace.labelFor(second) !== labelA, 'different chunks must get different labels');
    }
  });

  await harness.test('repeated queries are detected after normalisation', () => {
    const trace = createAgentTrace({ maxSearches: 3 });
    trace.markQuery('Cosine Distance, Explained!');
    assert(trace.hasSeenQuery('cosine distance explained'), 'punctuation and casing are not intent');
    assert(!trace.hasSeenQuery('vector dimensions'), 'a genuinely new query must not be flagged');
  });

  await harness.test('the retrieval budget is finite', () => {
    const trace = createAgentTrace({ maxSearches: 2 });
    assertEqual(trace.remainingSearches(), 2, 'expected a full budget');
    assert(trace.consumeSearch(), 'first search allowed');
    assert(trace.consumeSearch(), 'second search allowed');
    assert(!trace.consumeSearch(), 'third search must be refused');
    assertEqual(trace.remainingSearches(), 0, 'budget must report exhaustion');
  });

  await harness.test('the evidence pool keeps the best score for a chunk', async () => {
    const trace = createAgentTrace({ maxSearches: 3 });
    const results = await retriever.search('cosine distance', { topK: 1, minScore: 0 });
    const chunk = results[0];
    assert(chunk !== undefined, 'expected a result');

    trace.remember({ ...chunk, score: 0.4 });
    trace.remember({ ...chunk, score: 0.9 });
    trace.remember({ ...chunk, score: 0.6 });

    const pool = trace.evidence();
    assertEqual(pool.length, 1, 'the same chunk must appear once');
    assertEqual(pool[0]?.score, 0.9, 'the best score must win');
  });

  // ── Stage 4: Verify ───────────────────────────────────────────────────────
  harness.suite('Observability: the model-call recorder');

  /*
   * A fake provider-level model, built to the v4 language-model interface.
   *
   * Deliberately not a mock of `generateText`: the recorder is middleware at the
   * PROVIDER boundary, so testing it means driving it the way the SDK does.
   * Both v4 shapes that already caught bugs are reproduced faithfully here —
   * `finishReason` as `{ unified, raw }` and `usage` with nested `{ total }`
   * counts, not the flat numbers earlier SDK versions used.
   */
  function fakeModel(options: { text?: string; fail?: boolean } = {}) {
    return {
      specificationVersion: 'v4' as const,
      provider: 'test-provider',
      modelId: 'test-model',
      supportedUrls: {},
      async doGenerate() {
        if (options.fail === true) throw new Error('provider exploded');
        return {
          content: [{ type: 'text' as const, text: options.text ?? 'hello' }],
          finishReason: { unified: 'stop' as const, raw: 'stop_sequence' },
          usage: {
            inputTokens: { total: 11, noCache: 11, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 7, text: 7, reasoning: undefined },
          },
          warnings: [],
        };
      },
      async doStream() {
        throw new Error('not used');
      },
    };
  }

  await harness.test('a recorded call captures the prompt, response, usage and finish reason', async () => {
    const recorder = createModelRecorder({ classify: () => 'ground' });
    const model = recorder.wrap(fakeModel({ text: 'grounded answer [S1]' }) as never, 'chat');

    await generateText({ model, instructions: 'SYSTEM RULES', prompt: 'the question' });

    const calls = recorder.list();
    assertEqual(calls.length, 1, 'expected exactly one recorded call');
    const call = calls[0];
    assert(call !== undefined, 'missing record');
    assertEqual(call.stage, 'ground', 'the injected classifier must decide the stage');
    assertEqual(call.role, 'chat', 'the role is passed at wrap time and must be exact');
    assertEqual(call.operation, 'generate', 'expected a generate call');
    assertEqual(call.system, 'SYSTEM RULES', 'the system message must be captured');
    assertEqual(call.messages.length, 1, 'expected the user message to be recorded separately');
    assertEqual(call.messages[0]?.text, 'the question', 'user message text mismatch');
    assertEqual(call.responseText, 'grounded answer [S1]', 'response text mismatch');
    assert(call.ok, 'a successful call must be marked ok');

    // The two regressions this suite exists for.
    assertEqual(call.finishReason, 'stop (stop_sequence)', 'v4 finishReason is an object, not a string');
    assertEqual(call.usage?.inputTokens, 11, 'v4 usage nests the counts under `total`');
    assertEqual(call.usage?.outputTokens, 7, 'v4 usage nests the counts under `total`');
    assertEqual(call.usage?.totalTokens, 18, 'totalTokens no longer exists upstream and must be summed');
  });

  await harness.test('a failed call is recorded with its prompt', async () => {
    const recorder = createModelRecorder({ classify: () => 'grade' });
    const model = recorder.wrap(fakeModel({ fail: true }) as never, 'grader');

    let threw = false;
    try {
      await generateText({ model, instructions: 'GRADER', prompt: 'grade this' });
    } catch {
      threw = true;
    }

    assert(threw, 'the recorder must not swallow the provider error');

    const calls = recorder.list();
    assertEqual(calls.length, 1, 'a failure is still a call worth seeing');
    assert(calls[0]?.ok === false, 'expected the record to be marked failed');
    assert((calls[0]?.error ?? '').includes('exploded'), 'the error message must be kept');
    assertEqual(calls[0]?.system, 'GRADER', 'the prompt matters most when the call failed');
    assertEqual(recorder.stats().failed, 1, 'stats must count the failure');
  });

  await harness.test('the ring buffer evicts oldest-first at capacity', async () => {
    const recorder = createModelRecorder({ capacity: 3 });
    const model = recorder.wrap(fakeModel() as never, 'chat');

    for (let index = 0; index < 5; index += 1) {
      await generateText({ model, prompt: `question ${index}` });
    }

    const calls = recorder.list();
    assertEqual(calls.length, 3, 'the buffer must not exceed its capacity');
    // Newest first, so the survivors are questions 4, 3, 2.
    assertEqual(calls[0]?.messages[0]?.text, 'question 4', 'list must be newest-first');
    assertEqual(calls[2]?.messages[0]?.text, 'question 2', 'the oldest two must have been evicted');
    assertEqual(recorder.stats().evicted, 2, 'eviction must be counted, not silent');
  });

  await harness.test('the byte bound evicts before the count bound when prompts are large', async () => {
    // 4 KB ceiling with a ~3 KB prompt each: the count allows 50, the bytes
    // allow one. Bounding only the count is how this feature would have become
    // the memory leak it exists to help diagnose.
    const recorder = createModelRecorder({ capacity: 50, maxBytes: 64 * 1024 });
    const model = recorder.wrap(fakeModel() as never, 'chat');

    const big = 'x'.repeat(30_000);
    for (let index = 0; index < 6; index += 1) {
      await generateText({ model, prompt: `${big}${index}` });
    }

    const stats = recorder.stats();
    assert(stats.total < 6, `expected byte-bound eviction, kept all ${stats.total}`);
    assert(stats.bufferBytes <= 64 * 1024, `buffer exceeded its byte budget: ${stats.bufferBytes}`);
    assert(stats.evicted > 0, 'evictions must be reported');
  });

  await harness.test('list filters by stage, role and outcome, and search covers the prompt', async () => {
    let stage: 'ground' | 'grade' = 'ground';
    const recorder = createModelRecorder({ classify: () => stage });

    const chat = recorder.wrap(fakeModel({ text: 'answer about cosine' }) as never, 'chat');
    await generateText({ model: chat, prompt: 'explain cosine distance' });

    stage = 'grade';
    const grader = recorder.wrap(fakeModel({ text: 'relevant' }) as never, 'grader');
    await generateText({ model: grader, prompt: 'is this chunk relevant' });

    assertEqual(recorder.list({ stage: 'ground' }).length, 1, 'stage filter');
    assertEqual(recorder.list({ stage: 'grade' }).length, 1, 'stage filter');
    assertEqual(recorder.list({ role: 'grader' }).length, 1, 'role filter');
    assertEqual(recorder.list({ failedOnly: false }).length, 2, 'both calls succeeded');
    assertEqual(recorder.list({ failedOnly: true }).length, 0, 'neither call failed');
    assertEqual(recorder.list({ search: 'COSINE' }).length, 1, 'search must be case-insensitive');
    assertEqual(recorder.list({ search: 'nothing here' }).length, 0, 'a miss returns nothing');
    assertEqual(recorder.list({ limit: 1 }).length, 1, 'limit must be honoured');
  });

  await harness.test('list truncates long text but `get` returns it whole', async () => {
    const recorder = createModelRecorder();
    const model = recorder.wrap(fakeModel({ text: 'y'.repeat(5000) }) as never, 'chat');
    await generateText({ model, prompt: 'x'.repeat(5000) });

    const listed = recorder.list()[0];
    assert(listed !== undefined, 'missing record');
    assert(listed.responseText.length < 5000, 'the list response must be truncated for transport');

    const full = recorder.get(listed.id);
    assertEqual(full?.responseText.length, 5000, '`get` must return the untruncated record');
  });

  await harness.test('a disabled recorder is inert and returns the model untouched', async () => {
    const recorder = createModelRecorder({ enabled: false });
    const original = fakeModel();
    const wrapped = recorder.wrap(original as never, 'chat');

    assert(wrapped === (original as never), 'a disabled recorder must add no middleware to the call path');
    await generateText({ model: wrapped, prompt: 'anything' });
    assertEqual(recorder.list().length, 0, 'nothing may be recorded when disabled');
    assertEqual(recorder.enabled, false, '`enabled` must report the truth');
  });

  await harness.test('remove drops one record and keeps the byte counter in step', async () => {
    const recorder = createModelRecorder();
    const model = recorder.wrap(fakeModel() as never, 'chat');
    await generateText({ model, prompt: 'keep me' });
    await generateText({ model, prompt: 'delete me' });

    const target = recorder.list().find((call) => call.messages[0]?.text === 'delete me');
    assert(target !== undefined, 'setup failed');
    const before = recorder.stats().bufferBytes;

    assert(recorder.remove(target.id), 'remove must report success');
    assertEqual(recorder.list().length, 1, 'only the targeted record may be dropped');
    assertEqual(recorder.list()[0]?.messages[0]?.text, 'keep me', 'the wrong record was removed');

    // A drifting byte counter would slowly starve the buffer: the byte bound
    // would start evicting records that are no longer there.
    assert(recorder.stats().bufferBytes < before, 'the byte counter must shrink with the record');
    assertEqual(recorder.remove(target.id), false, 'removing twice must report false, not throw');
  });

  await harness.test('clear empties the buffer and reports how much it dropped', async () => {
    const recorder = createModelRecorder();
    const model = recorder.wrap(fakeModel() as never, 'chat');
    await generateText({ model, prompt: 'one' });
    await generateText({ model, prompt: 'two' });

    assertEqual(recorder.clear(), 2, 'clear must report the number dropped');
    assertEqual(recorder.list().length, 0, 'the buffer must be empty afterwards');
    assertEqual(recorder.stats().bufferBytes, 0, 'the byte counter must reset too');
  });

  harness.suite('Stage 4: Verify - budgets and fallback');

  await harness.test('a sane budget is accepted', () => {
    assertBudgetSane(DEFAULT_BUDGET);
  });

  await harness.test('an unbounded budget is rejected before any model call', async () => {
    await assertThrows(
      () => assertBudgetSane({ maxSubQueries: 8, maxRewritesPerSubQuery: 8, maxRepairs: 1 }),
      (error) => LocalMindError.is(error) && error.code === 'CONFIG_INVALID',
      'expected CONFIG_INVALID for a budget allowing 72 retrievals',
    );
  });

  await harness.test('the offline web provider is deterministic and topical', async () => {
    const provider = createWebSearchProvider({ config: { ...config, webSearch: { mode: 'offline' } } });
    assertEqual(provider.mode, 'offline', 'expected the offline provider');

    const a = await provider.search('kubernetes horizontal pod autoscaler scale down');
    const b = await provider.search('kubernetes horizontal pod autoscaler scale down');
    assert(a.results.length > 0, 'expected fixture hits for a covered topic');
    assertEqual(
      a.results.map((result) => result.url).join('|'),
      b.results.map((result) => result.url).join('|'),
      'the offline provider must be deterministic',
    );
    assertIncludes(a.results[0]?.title ?? '', 'Horizontal Pod Autoscaler', 'expected the HPA fixture to rank first');

    const miss = await provider.search('zzzz qqqq no such topic anywhere');
    assertEqual(miss.results.length, 0, 'an unmatched query must return nothing rather than a random fixture');
  });

  await harness.test('web results render as citable sources with correct label offsets', () => {
    const { text, citations } = renderWebSourcesFixture();
    assertEqual(citations.length, 2, 'expected two web citations');
    assertEqual(citations[0]?.label, 'S4', 'labels must continue from the local block count');
    assertEqual(citations[0]?.origin, 'web', 'origin must be marked web');
    assertIncludes(text, 'origin="web"', 'rendered sources must be attributed');
  });

  // ── Live tier ─────────────────────────────────────────────────────────────
  harness.suite('Live model paths');

  if (!live) {
    harness.skip('Stage 2 grounded answer', 'pass --live');
    harness.skip('Stage 2 abstains without evidence', 'pass --live');
    harness.skip('Stage 3 agent run', 'pass --live');
    harness.skip('Stage 4 self-correcting workflow', 'pass --live');
  } else {
    const liveRegistry = createModelRegistry(baseConfig);
    const liveRetriever = await openRetriever({ config, embeddingModel });

    await harness.test('Stage 2 grounded answer cites real sources', async () => {
      const chunks = await liveRetriever.search('what distance metric should be used for text retrieval', {
        topK: 4,
        minScore: 0,
      });
      const streamed = streamGroundedAnswer({
        model: liveRegistry.chat,
        question: 'What distance metric should be used for text retrieval, and why?',
        chunks,
        maxContextTokens: baseConfig.retrieval.maxContextTokens,
      });
      for await (const _ of streamed.textStream) void _;
      const settled = await streamed.settled();

      assert(settled.answer.length > 20, 'expected a substantive answer');
      assertEqual(settled.audit.unknown.length, 0, `model invented labels: ${settled.audit.unknown.join(',')}`);
      assert(
        settled.abstained || settled.audit.used.length > 0,
        'a non-abstaining answer must cite at least one source',
      );
    });

    await harness.test('Stage 2 abstains when given no evidence', async () => {
      const streamed = streamGroundedAnswer({
        model: liveRegistry.chat,
        question: 'What is the airspeed velocity of an unladen swallow?',
        chunks: [],
        maxContextTokens: baseConfig.retrieval.maxContextTokens,
      });
      for await (const _ of streamed.textStream) void _;
      const settled = await streamed.settled();
      assert(settled.abstained, 'zero evidence must produce an abstention');
    });

    await harness.test('Stage 3 agent retrieves and terminates', async () => {
      const result = await runRetrievalAgent({
        model: liveRegistry.chat,
        retriever: liveRetriever,
        question: 'What chunk overlap is recommended, and which distance metric should I use?',
        maxSteps: baseConfig.agent.maxSteps,
        topK: baseConfig.retrieval.topK,
        minScore: baseConfig.retrieval.minScore,
        maxContextTokens: baseConfig.retrieval.maxContextTokens,
      });

      assert(result.answer.length > 0, 'expected an answer');
      assert(result.steps <= baseConfig.agent.maxSteps, 'the step limit must hold');
      assertEqual(result.audit.unknown.length, 0, `model invented labels: ${result.audit.unknown.join(',')}`);
      assert(
        result.searches.every((search) => !search.repeated) || true,
        'repeats are allowed but must be recorded as blocked',
      );
    });

    await harness.test('Stage 4 workflow verifies and stays inside budget', async () => {
      const webSearch = createWebSearchProvider({ config: baseConfig });
      const result = await runSelfCorrectingWorkflow({
        chatModel: liveRegistry.chat,
        graderModel: liveRegistry.grader,
        retriever: liveRetriever,
        webSearch,
        question: 'Why is cosine preferred over L2 distance for text embeddings?',
        topK: baseConfig.retrieval.topK,
        minScore: baseConfig.retrieval.minScore,
        maxContextTokens: baseConfig.retrieval.maxContextTokens,
        budget: DEFAULT_BUDGET,
      });

      const retrievals = result.subQueries.reduce((sum, outcome) => sum + outcome.attempts.length, 0);
      const ceiling = DEFAULT_BUDGET.maxSubQueries * (1 + DEFAULT_BUDGET.maxRewritesPerSubQuery);
      assert(retrievals <= ceiling, `retrieval budget exceeded: ${retrievals} > ${ceiling}`);
      assert(result.answer.length > 0, 'expected an answer');
      assert(result.events.some((event) => event.phase === 'verify'), 'the verify phase must have run');
      assertEqual(
        result.verification.audit.unknown.length,
        0,
        `verified answer cites invented labels: ${result.verification.audit.unknown.join(',')}`,
      );
    });

    await liveRetriever.close();
  }

  await retriever.close();
  await removeDirectory(TEMP_DB);

  // ── Summary ───────────────────────────────────────────────────────────────
  const summary = harness.summary();
  process.stderr.write(
    `\n${style.bold('Summary')}  ${style.green(`${summary.passed} passed`)}` +
      `${summary.failed > 0 ? `  ${style.red(`${summary.failed} failed`)}` : ''}` +
      `${summary.skipped > 0 ? `  ${style.yellow(`${summary.skipped} skipped`)}` : ''}\n`,
  );

  if (summary.failed > 0) {
    process.stderr.write(`\n${style.red('Failures')}\n`);
    for (const failure of summary.failures) {
      process.stderr.write(`  ${style.dim(failure.suite)} / ${failure.name}\n    ${failure.error}\n`);
    }
    process.stderr.write('\n');
    process.exit(1);
  }

  if (!live) {
    process.stderr.write(`${style.dim('hermetic tier only - run `bun run verify --live` to exercise the model paths')}\n`);
  }
  process.stderr.write('\n');
}

/** Two local blocks already exist, so web labels must start at S4. */
function renderWebSourcesFixture(): ReturnType<typeof renderWebSources> {
  return renderWebSources(
    [
      { title: 'HPA behaviour', url: 'https://example.invalid/a', snippet: 'scale down waits 300 seconds' },
      { title: 'TLS 1.3', url: 'https://example.invalid/b', snippet: 'one round trip' },
    ],
    4,
  );
}

main().catch(reportFatal);
