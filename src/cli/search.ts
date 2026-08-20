import { style } from '../core/ansi';
import { openRetriever } from '../retrieval/retriever';

import { flagNumber, flagString, formatDuration, heading, requireQuestion, runCli } from './shared';

/**
 * `bun run search "<query>" [--top-k N] [--min-score F] [--where SQL] [--full]`
 *
 * STAGE 1 - INDEX. Pure retrieval, no model generation.
 *
 * This is the most useful debugging tool in the repo. When an answer in Stage
 * 2-4 is wrong, run the same query here first: if the right passage is not in
 * this list, the problem is chunking or embedding, not prompting. Diagnosing in
 * that order saves a great deal of time.
 */

await runCli('Stage 1: Index (search)', async ({ args, config, registry }) => {
  const query = requireQuestion(args, 'bun run search "your query" [--top-k 8] [--min-score 0.2] [--full]');
  const topK = flagNumber(args, 'top-k') ?? config.retrieval.topK;
  const minScore = flagNumber(args, 'min-score') ?? config.retrieval.minScore;
  const where = flagString(args, 'where');
  const full = args.flags['full'] === true;

  const retriever = await openRetriever({ config, embeddingModel: registry.embedding });

  try {
    const startedAt = Date.now();
    const results = await retriever.search(query, {
      topK,
      minScore,
      ...(where !== undefined ? { where } : {}),
    });
    const elapsed = Date.now() - startedAt;

    heading(`${results.length} result(s) for "${query}" in ${formatDuration(elapsed)}`);

    if (results.length === 0) {
      process.stderr.write(
        `\n  ${style.yellow('nothing above the relevance threshold.')}\n` +
          `  Try --min-score 0 to see the nearest neighbours regardless of score;\n` +
          `  if even those are unrelated, the corpus does not cover this topic.\n\n`,
      );
      return;
    }

    for (const [index, chunk] of results.entries()) {
      const section = chunk.headingPath.length > 0 ? ` ${style.dim(`> ${chunk.headingPath}`)}` : '';
      process.stderr.write(
        `\n  ${style.cyan(`#${index + 1}`)} ${style.bold(chunk.score.toFixed(3))} ` +
          `${style.dim(`(dist ${chunk.distance.toFixed(3)})`)}  ${chunk.title}${section}\n` +
          `     ${style.dim(`${chunk.relativePath}  chunk ${chunk.chunkIndex}  ~${chunk.tokenEstimate} tok  id ${chunk.id.slice(0, 12)}`)}\n`,
      );

      const body = full ? chunk.text : chunk.text.slice(0, 320);
      const suffix = !full && chunk.text.length > 320 ? style.dim(' [...]') : '';
      process.stderr.write(
        `${body
          .split('\n')
          .map((line) => `     ${line}`)
          .join('\n')}${suffix}\n`,
      );
    }

    process.stderr.write(`\n${style.dim('--full prints whole chunks; --where applies a SQL metadata filter')}\n\n`);
  } finally {
    await retriever.close();
  }
});
