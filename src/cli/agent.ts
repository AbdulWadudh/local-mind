import { style } from '../core/ansi';
import { runRetrievalAgent } from '../agent/retrieval-agent';
import { openRetriever } from '../retrieval/retriever';

import {
  flagNumber,
  formatDuration,
  heading,
  kv,
  printAnswer,
  printCitations,
  requireQuestion,
  runCli,
} from './shared';

/**
 * `bun run agent "<question>" [--max-steps N] [--top-k N]`
 *
 * STAGE 3 - DELEGATE. The model owns retrieval: it decides what to search for,
 * how to reformulate after a miss, and when it has enough to answer.
 *
 * Compare directly against Stage 2 on a compound question:
 *   bun run ask   "what chunk overlap should I use and which distance metric"
 *   bun run agent "what chunk overlap should I use and which distance metric"
 * Stage 2 makes one averaged query. Stage 3 issues two, and the step trace below
 * shows it happening.
 */

const STOP_REASON_NOTE: Readonly<Record<string, string>> = {
  'final-answer-tool': 'the model committed through the terminal tool (the intended exit)',
  'model-emitted-text': 'the model wrote prose instead of calling finalAnswer; common on small models',
  'step-limit': 'the step budget ran out before the model committed',
  'fallback-synthesis': 'the loop produced nothing, so the answer was synthesised from retrieved evidence',
};

await runCli('Stage 3: Delegate', async ({ args, config, registry, signal }) => {
  const question = requireQuestion(args, 'bun run agent "your question" [--max-steps 8] [--top-k 6]');
  const maxSteps = flagNumber(args, 'max-steps') ?? config.agent.maxSteps;
  const topK = flagNumber(args, 'top-k') ?? config.retrieval.topK;

  const retriever = await openRetriever({ config, embeddingModel: registry.embedding });

  try {
    heading('Agent trace');

    const result = await runRetrievalAgent({
      model: registry.chat,
      retriever,
      question,
      maxSteps,
      topK,
      minScore: config.retrieval.minScore,
      maxContextTokens: config.retrieval.maxContextTokens,
      signal,
      onStep: ({ step, toolCalls, text }) => {
        const tools = toolCalls.length > 0 ? style.cyan(toolCalls.join(', ')) : style.dim('no tool calls');
        const preview = text.trim().length > 0 ? ` ${style.dim(`"${text.trim().slice(0, 60)}..."`)}` : '';
        process.stderr.write(`  ${style.dim(`step ${step}`)}  ${tools}${preview}\n`);
      },
    });

    process.stderr.write('\n');
    printAnswer(result.answer);

    heading('Retrieval log');
    if (result.searches.length === 0) {
      process.stderr.write(`  ${style.yellow('the model never called the search tool')}\n`);
    }
    for (const search of result.searches) {
      const marker = search.repeated
        ? style.yellow('repeat')
        : search.budgetExhausted
          ? style.red('blocked')
          : search.resultCount === 0
            ? style.yellow('empty ')
            : style.green('ok    ');
      process.stderr.write(
        `  ${marker} ${style.dim(`step ${search.step}`)}  ${search.resultCount} hit(s)` +
          ` ${style.dim(`top ${search.topScore.toFixed(3)}`)}  "${search.query.slice(0, 70)}"\n`,
      );
    }

    printCitations([...result.citations], result.audit.used);

    heading('Agent report');
    kv('stop reason', `${result.stopReason} ${style.dim(`- ${STOP_REASON_NOTE[result.stopReason] ?? ''}`)}`);
    kv('confidence', result.confidence === 'insufficient' ? style.yellow(result.confidence) : result.confidence);
    kv('steps', `${result.steps}/${maxSteps}`);
    kv('searches', String(result.searches.length));
    kv('evidence pool', `${result.evidence.length} passage(s)`);
    kv('citations used', result.audit.used.length > 0 ? result.audit.used.join(', ') : style.dim('none'));
    if (result.audit.unknown.length > 0) kv('invented labels', style.red(result.audit.unknown.join(', ')));
    if (result.audit.uncitedSentences.length > 0) {
      kv('uncited claims', style.yellow(String(result.audit.uncitedSentences.length)));
    }
    kv('tokens', `${result.usage.inputTokens} in / ${result.usage.outputTokens} out`);
    kv('duration', formatDuration(result.durationMs));

    const repeats = result.searches.filter((search) => search.repeated).length;
    if (repeats > 0) {
      process.stderr.write(
        `\n${style.yellow(`${repeats} repeated quer(y/ies) were blocked`)} - without that guard this run would have looped\n`,
      );
    }
    process.stderr.write('\n');
  } finally {
    await retriever.close();
  }
});
