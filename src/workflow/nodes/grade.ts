import type { LanguageModel } from 'ai';
import { z } from 'zod';

import { createLogger } from '../../core/logger';
import { safeGenerateObject } from '../../core/resilience';
import { truncateToTokens } from '../../core/tokens';
import type { RetrievedChunk } from '../../core/types';

/**
 * STAGE 4 - VERIFY / node: GRADE
 *
 * Ask a model whether each retrieved passage actually answers the sub-query.
 *
 * WHY A GRADER, WHEN WE ALREADY HAVE A SIMILARITY SCORE
 * Cosine similarity measures topical proximity, not evidential value. These all
 * score highly against "what is the default chunk overlap":
 *   - a passage defining what overlap *is*        (topical, no answer)
 *   - a passage about overlap in a *different* system (topical, wrong answer)
 *   - a passage stating the default              (the answer)
 * Similarity cannot separate them; a reading model can. This is the single
 * highest-leverage node in the graph, because everything downstream is
 * conditioned on "do we actually have the evidence".
 *
 * WHY ONE CALL FOR ALL PASSAGES
 * Per-passage calls cost N times as much and, worse, remove the grader's ability
 * to compare. Judging six passages together lets it mark the one that actually
 * states the fact as `relevant` and the five that merely mention the topic as
 * `partial`. The cost is that one malformed response affects the whole batch —
 * which is why the fallback below is per-label rather than all-or-nothing.
 *
 * WHY IT FAILS OPEN
 * An unparseable grade defaults to `partial`, not `irrelevant`. A flaky grader
 * must never be able to silently delete correct evidence; the worst it can do is
 * let weak evidence through, and the VERIFY node is the backstop for that.
 */

const log = createLogger('workflow:grade');

/** Passages are truncated before grading: the grader reads, it does not quote. */
const GRADE_EXCERPT_TOKENS = 220;

export type Verdict = 'relevant' | 'partial' | 'irrelevant';

const GradeSchema = z.object({
  grades: z.array(
    z.object({
      label: z.string().describe('The source label being graded, e.g. "S1".'),
      verdict: z
        .enum(['relevant', 'partial', 'irrelevant'])
        .describe(
          'relevant = directly contains the fact needed to answer; partial = related and useful context but does not state the answer; irrelevant = same topic words, different subject, or no bearing on the query.',
        ),
      reason: z.string().max(200).describe('One short clause justifying the verdict.'),
    }),
  ),
});

export const GRADE_INSTRUCTIONS = `You are a strict relevance grader for a retrieval system.

For each SOURCE, decide whether it contains the information needed to answer the
QUERY.

Verdicts:
- "relevant": the passage states the answer, or a substantive part of it. A
  reader could answer the query from this passage alone.
- "partial": the passage is about the right subject and adds useful context, but
  does not state the answer.
- "irrelevant": the passage shares vocabulary with the query but concerns a
  different subject, or has no bearing on it.

Be strict. Sharing keywords is not relevance. If a passage merely defines a term
from the query without answering the query, that is "partial" at best. If it
discusses a different system that happens to use the same word, that is
"irrelevant".

Emit exactly one grade per source label provided, and use those labels verbatim.`;

export interface GradedChunk {
  readonly chunk: RetrievedChunk;
  readonly label: string;
  readonly verdict: Verdict;
  readonly reason: string;
  /** True when the grader did not return a usable verdict for this passage. */
  readonly assumed: boolean;
}

export interface GradeResult {
  readonly graded: readonly GradedChunk[];
  readonly kept: readonly RetrievedChunk[];
  readonly relevantCount: number;
  readonly partialCount: number;
  readonly irrelevantCount: number;
  /**
   * Is there enough evidence to attempt an answer?
   * One `relevant` passage suffices. Otherwise two `partial` passages are
   * required — a single tangential passage is exactly the input that produces a
   * confident, wrong, well-cited answer.
   */
  readonly sufficient: boolean;
  readonly degraded: boolean;
  readonly failure?: string;
}

export interface GradeOptions {
  readonly model: LanguageModel;
  readonly query: string;
  readonly chunks: readonly RetrievedChunk[];
  readonly signal?: AbortSignal;
}

export async function gradeChunks(options: GradeOptions): Promise<GradeResult> {
  if (options.chunks.length === 0) {
    return {
      graded: [],
      kept: [],
      relevantCount: 0,
      partialCount: 0,
      irrelevantCount: 0,
      sufficient: false,
      degraded: false,
    };
  }

  // Local labels, scoped to this grading call only. The graph re-labels for the
  // final answer, so these never leak into a citation.
  const labelled = options.chunks.map((chunk, index) => ({ label: `S${index + 1}`, chunk }));

  const rendered = labelled
    .map(({ label, chunk }) => {
      const { text } = truncateToTokens(chunk.text, GRADE_EXCERPT_TOKENS);
      const section = chunk.headingPath.length > 0 ? ` | section: ${chunk.headingPath}` : '';
      return `<source id="${label}" title="${chunk.title}"${section}>\n${text}\n</source>`;
    })
    .join('\n\n');

  const result = await safeGenerateObject({
    model: options.model,
    schema: GradeSchema,
    instructions: GRADE_INSTRUCTIONS,
    prompt: `QUERY: ${options.query}\n\nSOURCES:\n${rendered}\n\nGrade all ${labelled.length} sources.`,
    label: 'grade',
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  const byLabel = new Map<string, { verdict: Verdict; reason: string }>();
  if (result.ok) {
    for (const grade of result.value.grades) {
      // Normalise: models sometimes return "s1" or "[S1]".
      const label = grade.label.trim().replace(/[[\]]/gu, '').toUpperCase();
      byLabel.set(label, { verdict: grade.verdict, reason: grade.reason });
    }
  }

  const graded: GradedChunk[] = labelled.map(({ label, chunk }) => {
    const grade = byLabel.get(label);
    if (grade === undefined) {
      return {
        chunk,
        label,
        verdict: 'partial' as const,
        reason: result.ok ? 'grader omitted this source; assuming partial' : 'grader unavailable; assuming partial',
        assumed: true,
      };
    }
    return { chunk, label, verdict: grade.verdict, reason: grade.reason, assumed: false };
  });

  const relevantCount = graded.filter((entry) => entry.verdict === 'relevant').length;
  const partialCount = graded.filter((entry) => entry.verdict === 'partial').length;
  const irrelevantCount = graded.filter((entry) => entry.verdict === 'irrelevant').length;

  // Discard only what the grader positively rejected. Keep `partial` — it is
  // often the context that makes a `relevant` passage interpretable.
  const kept = graded.filter((entry) => entry.verdict !== 'irrelevant').map((entry) => entry.chunk);

  const sufficient = relevantCount >= 1 || partialCount >= 2;

  log.info('graded', {
    query: options.query.slice(0, 60),
    relevant: relevantCount,
    partial: partialCount,
    irrelevant: irrelevantCount,
    sufficient,
    assumed: graded.filter((entry) => entry.assumed).length,
  });

  return {
    graded,
    kept,
    relevantCount,
    partialCount,
    irrelevantCount,
    sufficient,
    degraded: !result.ok,
    ...(result.ok ? {} : { failure: result.error }),
  };
}
