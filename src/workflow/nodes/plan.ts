import type { LanguageModel } from 'ai';
import { z } from 'zod';

import { createLogger } from '../../core/logger';
import { safeGenerateObject } from '../../core/resilience';

/**
 * STAGE 4 - VERIFY / node: PLAN
 *
 * Decompose the question into retrievable sub-queries before touching the index.
 *
 * WHY PLAN AT ALL
 * Vector search retrieves on similarity to a single point in embedding space. A
 * compound question ("what chunk size should I use and which index type is
 * faster") has no single point: its embedding lands in the average of two
 * topics, which is often near neither. Splitting first is not an optimisation,
 * it is a correctness fix.
 *
 * WHY THIS NODE FAILS OPEN
 * If the planner produces nothing parseable, we proceed with the raw question as
 * the only sub-query. That is exactly Stage 2's behaviour — strictly no worse
 * than not having a planner — so a flaky small model degrades the pipeline to
 * the previous stage instead of breaking it.
 */

const log = createLogger('workflow:plan');

const PlanSchema = z.object({
  intent: z
    .string()
    .min(1)
    .describe('One sentence restating what the user actually wants to know.'),
  subQueries: z
    .array(
      z.object({
        query: z
          .string()
          .min(3)
          .describe('A search query in documentation terminology. One topic. Not a sentence.'),
        rationale: z.string().min(1).describe('Which part of the question this covers.'),
      }),
    )
    .min(1)
    .max(4)
    .describe('Between 1 and 4 sub-queries. Use 1 for a simple question; do not pad.'),
  /**
   * The planner's own guess at whether a local technical corpus can answer this.
   * Advisory only: it is a prior, not a decision, and the graph never skips
   * retrieval because of it. Recorded because it is a useful trace signal.
   */
  expectsLocalCoverage: z
    .boolean()
    .describe('True if this looks like a question a technical documentation corpus would cover.'),
});

export type QueryPlan = z.output<typeof PlanSchema>;

export const PLAN_INSTRUCTIONS = `You plan retrieval over a local technical documentation corpus.

Given a user question, produce the minimal set of search queries that would find
the evidence needed to answer it.

Rules:
- One topic per sub-query. Split compound questions ("X and Y") into separate
  sub-queries; never emit a query containing "and" joining two topics.
- Write queries in the vocabulary of documentation, not conversation. Drop
  "how do I", "please", "explain", "what is the best way to".
- Do not pad. A single-topic question gets exactly one sub-query.
- Never invent product, API or option names that the question does not imply.`;

export interface PlanOptions {
  readonly model: LanguageModel;
  readonly question: string;
  readonly signal?: AbortSignal;
}

export interface PlanResult {
  readonly plan: QueryPlan;
  /** True when the planner failed and we fell back to the raw question. */
  readonly degraded: boolean;
  readonly failure?: string;
}

export async function planQueries(options: PlanOptions): Promise<PlanResult> {
  const result = await safeGenerateObject({
    model: options.model,
    schema: PlanSchema,
    instructions: PLAN_INSTRUCTIONS,
    prompt: `QUESTION: ${options.question}`,
    label: 'plan',
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  if (!result.ok) {
    log.warn('planner failed; using the raw question as the only sub-query', { error: result.error });
    return {
      degraded: true,
      failure: result.error,
      plan: {
        intent: options.question,
        subQueries: [{ query: options.question, rationale: 'planner unavailable; using the question verbatim' }],
        expectsLocalCoverage: true,
      },
    };
  }

  // Defensive de-duplication: models frequently emit two sub-queries that
  // normalise to the same thing, which would double the retrieval cost for
  // identical results.
  const seen = new Set<string>();
  const subQueries = result.value.subQueries.filter((entry) => {
    const key = entry.query.toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
    if (key.length === 0 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const plan: QueryPlan =
    subQueries.length > 0
      ? { ...result.value, subQueries }
      : {
          ...result.value,
          subQueries: [{ query: options.question, rationale: 'planner returned only duplicates' }],
        };

  log.info('plan ready', {
    subQueries: plan.subQueries.length,
    expectsLocalCoverage: plan.expectsLocalCoverage,
  });

  return { plan, degraded: false };
}
