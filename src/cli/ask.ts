import { style } from '../core/ansi';
import { writeOut } from '../core/logger';
import { streamGroundedAnswer } from '../generation/grounded-answer';
import { openRetriever } from '../retrieval/retriever';

import {
  flagBoolean,
  flagNumber,
  formatDuration,
  heading,
  kv,
  printCitations,
  requireQuestion,
  runCli,
} from './shared';

/**
 * `bun run ask "<question>" [--top-k N] [--no-stream]`
 *
 * STAGE 2 - GROUND. Retrieve once, then answer strictly from what came back,
 * streamed, with citations.
 *
 * Note what this stage cannot do, because it motivates Stage 3: it embeds the
 * question verbatim and searches exactly once. A compound question gets one
 * averaged embedding that matches neither of its topics, and a conversationally
 * phrased question gets no match at all. Try
 *   bun run ask "what chunk overlap should I use and which distance metric"
 * and watch it half-answer.
 */

await runCli('Stage 2: Ground', async ({ args, config, registry, signal }) => {
  const question = requireQuestion(args, 'bun run ask "your question" [--top-k 8] [--no-stream]');
  const topK = flagNumber(args, 'top-k') ?? config.retrieval.topK;
  const noStream = flagBoolean(args, 'no-stream');

  const retriever = await openRetriever({ config, embeddingModel: registry.embedding });

  try {
    const startedAt = Date.now();

    process.stderr.write(`${style.dim(`retrieving (topK=${topK})...`)}\n`);
    const chunks = await retriever.search(question, { topK, minScore: config.retrieval.minScore });
    process.stderr.write(
      `${style.dim(`${chunks.length} passage(s), top score ${(chunks[0]?.score ?? 0).toFixed(3)}`)}\n\n`,
    );

    const streamed = streamGroundedAnswer({
      model: registry.chat,
      question,
      chunks,
      maxContextTokens: config.retrieval.maxContextTokens,
      signal,
    });

    if (noStream) {
      // Draining without printing, then printing the settled text, is how you
      // get a clean single-write answer while still using the streaming path.
      for await (const _ of streamed.textStream) void _;
      const settled = await streamed.settled();
      writeOut(`${settled.answer.trimEnd()}\n`);
      report(settled, startedAt);
    } else {
      for await (const delta of streamed.textStream) writeOut(delta);
      writeOut('\n');
      report(await streamed.settled(), startedAt);
    }
  } finally {
    await retriever.close();
  }

  function report(
    settled: Awaited<ReturnType<ReturnType<typeof streamGroundedAnswer>['settled']>>,
    startedAt: number,
  ): void {
    printCitations([...settled.citations], settled.audit.used);

    heading('Grounding report');
    kv('abstained', settled.abstained ? style.yellow('yes') : 'no');
    kv('context', `${settled.context.tokensUsed}/${settled.context.tokenBudget} tokens, ${settled.context.blocks.length} block(s)`);
    if (settled.context.degraded) {
      kv('degraded', style.yellow(`${settled.context.droppedChunkIds.length} passage(s) dropped for budget`));
    }
    kv('citations used', settled.audit.used.length > 0 ? settled.audit.used.join(', ') : style.dim('none'));

    if (settled.audit.unknown.length > 0) {
      kv('invented labels', style.red(settled.audit.unknown.join(', ')));
    }
    if (settled.audit.uncitedSentences.length > 0) {
      kv('uncited claims', style.yellow(String(settled.audit.uncitedSentences.length)));
      for (const sentence of settled.audit.uncitedSentences.slice(0, 3)) {
        process.stderr.write(`      ${style.dim(`- ${sentence.slice(0, 110)}...`)}\n`);
      }
    }

    kv('tokens', `${settled.usage.inputTokens} in / ${settled.usage.outputTokens} out`);
    kv('duration', formatDuration(Date.now() - startedAt));

    if (settled.abstained) {
      process.stderr.write('\n');
    } else if (settled.audit.used.length === 0) {
      // A clean audit with zero citations is not a pass: it means the model
      // produced something with no factual sentences long enough to flag, which
      // in practice means it ignored the task. Reporting it as grounded would be
      // the exact failure this pipeline exists to prevent.
      process.stderr.write(
        `\n${style.yellow('the answer cites nothing')} - the model did not follow the grounding contract.\n` +
          `  ${style.dim('A weaker chat model is the usual cause. Retrieval itself is fine if `bun run search` looked right.')}\n\n`,
      );
    } else if (settled.audit.ok) {
      process.stderr.write(`\n${style.green('every factual sentence carries a valid citation')}\n\n`);
    } else {
      process.stderr.write(
        `\n${style.yellow('citation audit found problems')} - this is exactly what Stage 4 verification catches\n\n`,
      );
    }
  }
});
