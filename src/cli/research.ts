import { style } from '../core/ansi';
import { createModelRegistry } from '../core/providers';
import { openRetriever } from '../retrieval/retriever';
import { DEFAULT_BUDGET, assertBudgetSane, runSelfCorrectingWorkflow } from '../workflow/graph';
import type { WorkflowBudget, WorkflowPhase } from '../workflow/graph';
import { createWebSearchProvider } from '../workflow/web-search';

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
 * `bun run research "<question>" [--max-rewrites N] [--max-repairs N] [--max-subqueries N]`
 *
 * STAGE 4 - VERIFY. Plan, retrieve, grade, self-correct, fall back to the web,
 * generate, verify, repair.
 *
 * The phase trace printed below is the point of this stage: every transition is
 * a line you can read, and the worst-case number of model calls is a product of
 * the budget flags rather than whatever the model felt like doing.
 *
 * To watch self-correction actually fire, ask something the corpus does not
 * cover:
 *   bun run research "how does the kubernetes horizontal pod autoscaler decide to scale down"
 * Local retrieval finds nothing relevant, rewriting fails to help, and the web
 * fallback answers it - all visible in the trace.
 */

const PHASE_COLOUR: Readonly<Record<WorkflowPhase, (text: string) => string>> = {
  plan: style.magenta,
  retrieve: style.cyan,
  grade: style.blue,
  rewrite: style.yellow,
  'web-search': style.magenta,
  generate: style.cyan,
  verify: style.blue,
  repair: style.yellow,
  done: style.green,
};

await runCli('Stage 4: Verify', async ({ args, config, registry, signal }) => {
  const question = requireQuestion(
    args,
    'bun run research "your question" [--max-rewrites 2] [--max-repairs 1] [--max-subqueries 3]',
  );

  const budget: WorkflowBudget = {
    maxRewritesPerSubQuery: flagNumber(args, 'max-rewrites') ?? DEFAULT_BUDGET.maxRewritesPerSubQuery,
    maxRepairs: flagNumber(args, 'max-repairs') ?? DEFAULT_BUDGET.maxRepairs,
    maxSubQueries: flagNumber(args, 'max-subqueries') ?? DEFAULT_BUDGET.maxSubQueries,
  };

  // Fail in milliseconds on a bad budget rather than after forty model calls.
  assertBudgetSane(budget);

  const webSearch = createWebSearchProvider({
    config,
    onlineModelFactory: (slug) =>
      createModelRegistry({ ...config, chat: { ...config.chat, model: slug } }).chat,
  });

  const retriever = await openRetriever({ config, embeddingModel: registry.embedding });

  try {
    kv('budget', `${budget.maxSubQueries} sub-queries x ${budget.maxRewritesPerSubQuery} rewrites, ${budget.maxRepairs} repair(s)`);
    kv('web fallback', webSearch.describe);

    heading('Workflow trace');

    const result = await runSelfCorrectingWorkflow({
      chatModel: registry.chat,
      graderModel: registry.grader,
      retriever,
      webSearch,
      question,
      topK: config.retrieval.topK,
      minScore: config.retrieval.minScore,
      maxContextTokens: config.retrieval.maxContextTokens,
      budget,
      signal,
      onEvent: (event) => {
        const paint = PHASE_COLOUR[event.phase];
        process.stderr.write(`  ${paint(event.phase.padEnd(11))} ${event.message}\n`);
      },
    });

    process.stderr.write('\n');
    printAnswer(result.answer);

    heading('Sub-query outcomes');
    for (const outcome of result.subQueries) {
      const status = outcome.resolved
        ? style.green('resolved')
        : outcome.usedWebFallback
          ? style.magenta('web     ')
          : style.red('failed  ');
      process.stderr.write(`  ${status} "${outcome.query.slice(0, 70)}"\n`);
      for (const [index, attempt] of outcome.attempts.entries()) {
        process.stderr.write(
          `      ${style.dim(`attempt ${index + 1}`)} ${attempt.retrieved} retrieved -> ` +
            `${style.green(`${attempt.grade.relevantCount} relevant`)}, ` +
            `${attempt.grade.partialCount} partial, ` +
            `${style.dim(`${attempt.grade.irrelevantCount} irrelevant`)}` +
            `${attempt.query !== outcome.query ? style.dim(`  "${attempt.query.slice(0, 45)}"`) : ''}\n`,
        );
      }
    }

    printCitations([...result.citations], result.verification.audit.used);

    heading('Verification');
    const verdict = result.verification.grounded
      ? style.green('grounded')
      : result.verification.confident
        ? style.red('not grounded')
        : style.yellow('unverified');
    kv('verdict', `${verdict} ${style.dim(`(tier: ${result.verification.tier})`)}`);
    kv('reason', result.verification.reason);
    if (result.verification.unsupportedClaims.length > 0) {
      kv('unsupported', String(result.verification.unsupportedClaims.length));
      for (const claim of result.verification.unsupportedClaims.slice(0, 4)) {
        process.stderr.write(
          `      ${style.dim(`[${claim.problem}] ${claim.citedLabel}: "${claim.claim.slice(0, 90)}"`)}\n`,
        );
      }
    }

    heading('Workflow report');
    kv('sub-queries', String(result.subQueries.length));
    kv('web results', String(result.webResults.length));
    kv('repaired', result.repaired ? style.yellow('yes (one regeneration)') : 'no');
    kv('abstained', result.abstained ? style.yellow('yes') : 'no');
    kv('model calls', String(result.events.filter((event) => event.phase !== 'done').length));
    kv('tokens', `${result.usage.inputTokens} in / ${result.usage.outputTokens} out`);
    kv('duration', formatDuration(result.durationMs));

    if (!result.verification.confident) {
      process.stderr.write(
        `\n${style.yellow('verification could not run')} - the answer above is unverified, not necessarily wrong\n`,
      );
    }
    process.stderr.write('\n');
  } finally {
    await retriever.close();
  }
});
