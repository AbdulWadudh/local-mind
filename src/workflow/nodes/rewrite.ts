import type { LanguageModel } from 'ai';
import { z } from 'zod';

import { createLogger } from '../../core/logger';
import { safeGenerateObject } from '../../core/resilience';
import { QUERY_REWRITE_INSTRUCTIONS } from '../../generation/prompt';

/**
 * STAGE 4 - VERIFY / node: REWRITE
 *
 * Self-correction, retrieval edition: the previous query failed, produce a
 * better one.
 *
 * THE LOOP HAZARD THIS NODE CREATES
 * A rewrite node is a cycle in the graph, and cycles are where agent pipelines
 * hang. Three independent constraints keep it finite:
 *
 *  1. The caller owns the budget. `maxRewrites` lives in the graph, not here;
 *     this node has no ability to schedule itself.
 *  2. Rejection of non-progress. If the rewrite normalises to something already
 *     tried, it is refused and reported as `progressed: false`, and the graph
 *     stops rewriting immediately rather than spending the remaining budget on
 *     cosmetic variations.
 *  3. Failure is terminal, not retried. If the rewriter itself fails, we do not
 *     try again with the same input; we return `progressed: false`.
 */

const log = createLogger('workflow:rewrite');

const RewriteSchema = z.object({
  query: z.string().min(3).max(300).describe('The improved search query.'),
  strategy: z
    .enum(['terminology', 'narrow', 'broaden', 'decompose'])
    .describe(
      'terminology = same intent in documentation vocabulary; narrow = add the most distinctive term; broaden = generalise one level; decompose = keep only the single most important sub-question.',
    ),
  reasoning: z.string().max(200).describe('One clause on why this should retrieve better.'),
});

export type RewriteStrategy = z.output<typeof RewriteSchema>['strategy'];

export interface RewriteResult {
  readonly query: string;
  readonly strategy: RewriteStrategy | 'none';
  readonly reasoning: string;
  /** False when the rewrite is unusable or a repeat; the graph must stop. */
  readonly progressed: boolean;
}

export interface RewriteOptions {
  readonly model: LanguageModel;
  readonly originalQuestion: string;
  readonly failedQuery: string;
  readonly triedQueries: readonly string[];
  /** Why the last attempt failed, e.g. "0 hits" or "all passages graded irrelevant". */
  readonly failureReason: string;
  readonly signal?: AbortSignal;
}

function normalise(query: string): string {
  return query.toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
}

export async function rewriteQuery(options: RewriteOptions): Promise<RewriteResult> {
  const tried = options.triedQueries.map((query) => `- "${query}"`).join('\n');

  const result = await safeGenerateObject({
    model: options.model,
    schema: RewriteSchema,
    instructions: QUERY_REWRITE_INSTRUCTIONS,
    prompt: [
      `ORIGINAL QUESTION: ${options.originalQuestion}`,
      `FAILED QUERY: ${options.failedQuery}`,
      `WHY IT FAILED: ${options.failureReason}`,
      '',
      'ALREADY TRIED (do not repeat any of these):',
      tried,
      '',
      'Produce one new query.',
    ].join('\n'),
    label: 'rewrite',
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  if (!result.ok) {
    log.warn('rewriter failed; stopping the correction loop', { error: result.error });
    return {
      query: options.failedQuery,
      strategy: 'none',
      reasoning: `rewriter unavailable: ${result.error}`,
      progressed: false,
    };
  }

  const candidate = result.value.query.trim();
  const alreadyTried = new Set(options.triedQueries.map(normalise));

  if (candidate.length === 0 || alreadyTried.has(normalise(candidate))) {
    log.warn('rewrite made no progress', { candidate: candidate.slice(0, 60) });
    return {
      query: options.failedQuery,
      strategy: 'none',
      reasoning: 'rewrite duplicated an earlier query',
      progressed: false,
    };
  }

  log.info('query rewritten', {
    strategy: result.value.strategy,
    from: options.failedQuery.slice(0, 50),
    to: candidate.slice(0, 50),
  });

  return {
    query: candidate,
    strategy: result.value.strategy,
    reasoning: result.value.reasoning,
    progressed: true,
  };
}
