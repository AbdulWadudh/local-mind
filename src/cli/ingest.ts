import { style } from '../core/ansi';
import { ingestCorpus } from '../ingest/pipeline';

import { flagBoolean, formatDuration, heading, kv, runCli } from './shared';

/**
 * `bun run ingest [--rebuild] [--prune]`
 *
 * STAGE 1 - INDEX. Builds the semantic index: load, chunk, embed, upsert.
 *
 *   --rebuild  Drop and recreate the table. Required after changing the
 *              embedding model or the chunk size, because both invalidate every
 *              vector already stored.
 *   --prune    Delete rows for documents no longer present in the corpus.
 *              Without it, deleting a source file leaves its chunks retrievable.
 */

await runCli('Stage 1: Index (ingest)', async ({ args, config, registry, signal }) => {
  const rebuild = flagBoolean(args, 'rebuild');
  const prune = flagBoolean(args, 'prune');

  if (rebuild) process.stderr.write(`${style.yellow('--rebuild: the existing table will be dropped')}\n`);

  let lastStage = '';
  const report = await ingestCorpus({
    config,
    registry,
    signal,
    ...(rebuild ? { rebuild: true } : {}),
    ...(prune ? { prune: true } : {}),
    onProgress: (stage, done, total) => {
      // One rewritten line per stage rather than a log per batch: embedding a
      // corpus on CPU is slow, and silence is indistinguishable from a hang.
      if (stage !== lastStage) {
        if (lastStage !== '') process.stderr.write('\n');
        lastStage = stage;
      }
      const percent = total === 0 ? 100 : Math.round((done / total) * 100);
      process.stderr.write(`\r  ${stage.padEnd(8)} ${String(percent).padStart(3)}%  ${done}/${total}   `);
    },
  });

  if (lastStage !== '') process.stderr.write('\n');

  heading('Ingest report');
  kv('documents', String(report.documents));
  kv('chunks', String(report.chunks));
  kv('chunk tokens', `mean ${report.chunkStats.meanTokens}, min ${report.chunkStats.minTokens}, max ${report.chunkStats.maxTokens}`);
  kv('dimensions', String(report.dimensions));
  kv('rows upserted', String(report.rowsUpserted));
  if (report.rowsPruned > 0) kv('rows pruned', String(report.rowsPruned));
  kv('rows in table', String(report.totalRows));
  kv('duration', formatDuration(report.durationMs));
  kv('index path', `${config.store.dbPath} # ${config.store.tableName}`);

  // A chunk count below the document count means the splitter collapsed
  // documents, which is almost always a misconfigured chunk size.
  if (report.chunks < report.documents) {
    process.stderr.write(
      `\n${style.yellow('warning')} fewer chunks than documents; LOCALMIND_CHUNK_CHARS may be larger than your documents\n`,
    );
  }

  process.stderr.write(`\n${style.green('index ready')} - try: bun run search "cosine distance"\n\n`);
});
