import type { LanguageModel } from 'ai';
import { z } from 'zod';

import { createLogger } from '../../core/logger';
import { safeGenerateObject } from '../../core/resilience';
import type { Citation } from '../../core/types';
import { auditCitations } from '../../retrieval/context';
import type { CitationAudit } from '../../retrieval/context';

/**
 * STAGE 4 - VERIFY / node: VERIFY
 *
 * The last gate: does the answer actually follow from the sources it cites?
 *
 * TWO-TIER VERIFICATION, CHEAPEST FIRST
 *
 *  Tier 1 - deterministic (`auditCitations`, no model call). Catches invented
 *  labels (`[S9]` when only S1-S4 exist) and long uncited assertions. This is
 *  free, cannot itself hallucinate, and catches the most common failure. If it
 *  fails, we do not spend a model call to confirm.
 *
 *  Tier 2 - semantic (one structured model call). Catches the failure Tier 1
 *  cannot see: a sentence that carries a valid citation whose source does not
 *  actually support it. Citation-shaped text is not evidence, and models will
 *  happily attach `[S1]` to a claim S1 never made.
 *
 * WHY THIS NODE FAILS CLOSED
 * Opposite policy to GRADE, deliberately. If the verifier is unavailable we
 * report `grounded: false` with `confident: false`. An unverified answer must
 * never be presented as verified; the graph surfaces it with an explicit
 * "could not verify" warning rather than a green tick.
 */

const log = createLogger('workflow:verify');

const VerifySchema = z.object({
  grounded: z
    .boolean()
    .describe('True only if every factual claim in the answer is supported by the source it cites.'),
  unsupportedClaims: z
    .array(
      z.object({
        claim: z.string().max(300).describe('The sentence or clause that is not supported.'),
        citedLabel: z.string().describe('The label it cited, or "none".'),
        problem: z
          .enum(['not-in-source', 'contradicts-source', 'no-citation', 'overstated'])
          .describe(
            'not-in-source = the cited source does not mention this; contradicts-source = the source says something different; no-citation = a factual claim with no label; overstated = the source hedges but the answer asserts.',
          ),
      }),
    )
    .describe('Empty when the answer is fully grounded.'),
  verdictReason: z.string().max(300).describe('One or two sentences summarising the judgement.'),
});

export interface VerifyResult {
  readonly grounded: boolean;
  /** False when verification could not actually be performed. */
  readonly confident: boolean;
  readonly audit: CitationAudit;
  readonly unsupportedClaims: readonly {
    readonly claim: string;
    readonly citedLabel: string;
    readonly problem: string;
  }[];
  readonly reason: string;
  /** Which tier produced the verdict. */
  readonly tier: 'deterministic' | 'semantic' | 'unavailable';
}

export interface VerifyOptions {
  readonly model: LanguageModel;
  readonly question: string;
  readonly answer: string;
  readonly contextText: string;
  readonly citations: readonly Citation[];
  readonly signal?: AbortSignal;
}

export const VERIFY_INSTRUCTIONS = `You audit whether an ANSWER is grounded in its SOURCES.

You are not judging whether the answer is helpful, well written, or true in
general. You are judging one thing only: is every factual claim supported by the
source it cites?

Method: take each sentence of the answer that asserts a fact. Find its citation
label. Read that source. Decide whether the source states the claim.

Mark a claim unsupported when:
- the cited source does not contain the information (not-in-source)
- the cited source states something different (contradicts-source)
- the claim is factual but carries no citation (no-citation)
- the source qualifies or hedges the claim but the answer asserts it flatly
  (overstated)

Do not mark a claim unsupported merely because it paraphrases rather than quotes.
Do not mark connective or structural sentences that assert no fact.

An answer that correctly says the sources are insufficient is grounded: it
asserts nothing unsupported.`;

export async function verifyAnswer(options: VerifyOptions): Promise<VerifyResult> {
  // ── Tier 1: deterministic ────────────────────────────────────────────────
  const audit = auditCitations(options.answer, options.citations);

  if (audit.unknown.length > 0) {
    log.warn('verification failed deterministically: invented citation labels', {
      unknown: audit.unknown.join(','),
    });
    return {
      grounded: false,
      confident: true,
      audit,
      unsupportedClaims: audit.unknown.map((label) => ({
        claim: `answer cites ${label}, which is not among the provided sources`,
        citedLabel: label,
        problem: 'not-in-source',
      })),
      reason: `The answer cites ${audit.unknown.length} label(s) that do not exist: ${audit.unknown.join(', ')}.`,
      tier: 'deterministic',
    };
  }

  // ── Tier 2: semantic ─────────────────────────────────────────────────────
  const result = await safeGenerateObject({
    model: options.model,
    schema: VerifySchema,
    instructions: VERIFY_INSTRUCTIONS,
    prompt: [
      `QUESTION: ${options.question}`,
      '',
      '<sources>',
      options.contextText,
      '</sources>',
      '',
      '<answer>',
      options.answer,
      '</answer>',
    ].join('\n'),
    label: 'verify',
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  if (!result.ok) {
    // Fail closed.
    log.warn('verifier unavailable; reporting unverified', { error: result.error });
    return {
      grounded: false,
      confident: false,
      audit,
      unsupportedClaims: [],
      reason: `Verification could not be performed (${result.error}). The answer is unverified, not necessarily wrong.`,
      tier: 'unavailable',
    };
  }

  // Reconcile the two tiers. The deterministic uncited-sentence check is
  // evidence the semantic verifier does not get to overrule: if there are long
  // uncited assertions, the answer is not grounded regardless of the verdict.
  const uncited = audit.uncitedSentences.length;
  const grounded = result.value.grounded && result.value.unsupportedClaims.length === 0 && uncited === 0;

  const unsupportedClaims = [
    ...result.value.unsupportedClaims.map((entry) => ({
      claim: entry.claim,
      citedLabel: entry.citedLabel,
      problem: entry.problem,
    })),
    ...audit.uncitedSentences.slice(0, 3).map((sentence) => ({
      claim: sentence,
      citedLabel: 'none',
      problem: 'no-citation',
    })),
  ];

  log.info('verified', {
    grounded,
    unsupported: unsupportedClaims.length,
    uncitedSentences: uncited,
  });

  // When Tier 1 overrules Tier 2, say so. Reporting the semantic verifier's
  // "everything is supported" verdict next to `grounded: false` reads as a bug
  // in the verifier rather than the deliberate precedence rule that it is.
  const reason =
    result.value.grounded && !grounded
      ? `The semantic check passed ("${result.value.verdictReason}") but ${uncited} factual sentence(s) carry no citation, which the deterministic check treats as ungrounded.`
      : result.value.verdictReason;

  return {
    grounded,
    confident: true,
    audit,
    unsupportedClaims,
    reason,
    tier: 'semantic',
  };
}

/**
 * Build the corrective addendum handed back to the generator on a repair pass.
 *
 * Naming the specific offending sentences works markedly better than a generic
 * "be more careful": it converts an abstract instruction into a concrete edit
 * list, which is a much easier task.
 */
export function buildRepairDirective(verification: VerifyResult): string {
  const problems = verification.unsupportedClaims
    .slice(0, 6)
    .map((entry, index) => `${index + 1}. [${entry.problem}] cited ${entry.citedLabel}: "${entry.claim}"`)
    .join('\n');

  return [
    'A previous draft of this answer failed grounding verification.',
    '',
    'Problems found:',
    problems.length > 0 ? problems : '- (no specific claims isolated; the draft was insufficiently cited)',
    '',
    'Rewrite the answer so that:',
    '- every one of those claims is either removed, or restated to match exactly what its source says;',
    '- every remaining factual sentence carries a citation label that genuinely supports it;',
    '- if the sources do not support a claim at all, drop it rather than softening it.',
    '',
    'If, after removing unsupported claims, the sources no longer answer the question, abstain with',
    'INSUFFICIENT_CONTEXT instead of producing a thin answer.',
  ].join('\n');
}
