import type { LanguageModel } from 'ai';

import { LocalMindError } from '../core/errors';
import { createLogger } from '../core/logger';
import type { Citation, RetrievedChunk, Retriever } from '../core/types';
import { generateGroundedAnswer } from '../generation/grounded-answer';
import { assembleContext, renderWebSources } from '../retrieval/context';

import { gradeChunks } from './nodes/grade';
import type { GradeResult } from './nodes/grade';
import { planQueries } from './nodes/plan';
import type { QueryPlan } from './nodes/plan';
import { rewriteQuery } from './nodes/rewrite';
import { buildRepairDirective, verifyAnswer } from './nodes/verify';
import type { VerifyResult } from './nodes/verify';
import type { WebSearchProvider } from './web-search';
import type { WebResult } from '../core/types';

/**
 * STAGE 4 - VERIFY
 *
 * The self-correcting workflow.
 *
 * HOW THIS DIFFERS FROM STAGE 3, AND WHY BOTH EXIST
 * Stage 3 gave the model tools and let it decide the control flow. That is the
 * right shape for open-ended questions, and the wrong shape for a pipeline you
 * need to reason about: you cannot guarantee the model grades its own retrieval,
 * and you cannot guarantee it verifies its own answer, because "did you check
 * your work" is itself just another instruction it may ignore.
 *
 * Here the control flow is ordinary TypeScript — `if`, `for`, a bounded `while`
 * — and the model is called only for the judgements that genuinely need
 * language understanding: plan, grade, rewrite, generate, verify. Every
 * transition is inspectable, every loop has a numeric budget, and the same
 * question follows the same path every time.
 *
 * THE PIPELINE
 *
 *   PLAN                       decompose into sub-queries
 *     |
 *     +-- for each sub-query:
 *     |     RETRIEVE  ->  GRADE
 *     |       ^              |
 *     |       |  insufficient & rewrites left
 *     |       +-- REWRITE ---+
 *     |                      |
 *     |                      | insufficient & rewrites spent
 *     |                      +-- WEB SEARCH (fallback)
 *     |
 *   GENERATE                  grounded answer over surviving evidence
 *     |
 *   VERIFY                    two-tier groundedness gate
 *     |
 *     +-- not grounded & repairs left --> REPAIR (regenerate) --> VERIFY
 *     |
 *   DONE
 *
 * Every loop above is bounded by `WorkflowBudget`. The worst case is
 * `subQueries x (1 + maxRewrites)` retrievals plus `1 + maxRepairs`
 * generations — a number you can compute before you run it, which is the whole
 * point of building it this way.
 */

const log = createLogger('workflow:graph');

export type WorkflowPhase =
  | 'plan'
  | 'retrieve'
  | 'grade'
  | 'rewrite'
  | 'web-search'
  | 'generate'
  | 'verify'
  | 'repair'
  | 'done';

export interface WorkflowEvent {
  readonly phase: WorkflowPhase;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

export interface WorkflowBudget {
  /** Retrieval attempts per sub-query beyond the first. */
  readonly maxRewritesPerSubQuery: number;
  /** Regeneration attempts after a failed verification. */
  readonly maxRepairs: number;
  /** Upper bound on sub-queries actually executed, whatever the planner says. */
  readonly maxSubQueries: number;
}

export const DEFAULT_BUDGET: WorkflowBudget = {
  maxRewritesPerSubQuery: 2,
  maxRepairs: 1,
  maxSubQueries: 3,
};

export interface RetrievalAttempt {
  readonly query: string;
  readonly retrieved: number;
  readonly grade: Pick<GradeResult, 'relevantCount' | 'partialCount' | 'irrelevantCount' | 'sufficient'>;
}

export interface SubQueryOutcome {
  readonly query: string;
  readonly attempts: readonly RetrievalAttempt[];
  readonly kept: readonly RetrievedChunk[];
  readonly resolved: boolean;
  readonly usedWebFallback: boolean;
}

export interface WorkflowResult {
  readonly answer: string;
  readonly plan: QueryPlan;
  readonly subQueries: readonly SubQueryOutcome[];
  readonly citations: readonly Citation[];
  readonly webResults: readonly WebResult[];
  readonly verification: VerifyResult;
  readonly repaired: boolean;
  readonly abstained: boolean;
  readonly events: readonly WorkflowEvent[];
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly durationMs: number;
}

export interface RunWorkflowOptions {
  readonly chatModel: LanguageModel;
  /** Cheaper model for plan/grade/rewrite/verify. May be the same instance. */
  readonly graderModel: LanguageModel;
  readonly retriever: Retriever;
  readonly webSearch: WebSearchProvider;
  readonly question: string;
  readonly topK: number;
  readonly minScore: number;
  readonly maxContextTokens: number;
  readonly budget?: WorkflowBudget;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: WorkflowEvent) => void;
}

export async function runSelfCorrectingWorkflow(options: RunWorkflowOptions): Promise<WorkflowResult> {
  const startedAt = Date.now();
  const budget = options.budget ?? DEFAULT_BUDGET;
  const events: WorkflowEvent[] = [];

  let inputTokens = 0;
  let outputTokens = 0;

  const emit = (phase: WorkflowPhase, message: string, data?: Record<string, unknown>): void => {
    const event: WorkflowEvent = { phase, message, ...(data !== undefined ? { data } : {}) };
    events.push(event);
    options.onEvent?.(event);
    log.info(`[${phase}] ${message}`, data);
  };

  const signalOpt = options.signal !== undefined ? { signal: options.signal } : {};

  // ── PLAN ──────────────────────────────────────────────────────────────────
  emit('plan', `planning retrieval for: ${options.question}`);
  const { plan, degraded: planDegraded } = await planQueries({
    model: options.graderModel,
    question: options.question,
    ...signalOpt,
  });

  if (planDegraded) emit('plan', 'planner degraded; using the raw question', { subQueries: 1 });
  else emit('plan', `${plan.subQueries.length} sub-quer(y/ies)`, {
    queries: plan.subQueries.map((entry) => entry.query),
  });

  const activeSubQueries = plan.subQueries.slice(0, budget.maxSubQueries);
  if (activeSubQueries.length < plan.subQueries.length) {
    emit('plan', `capped to ${budget.maxSubQueries} sub-queries by budget`, {
      dropped: plan.subQueries.length - activeSubQueries.length,
    });
  }

  // ── RETRIEVE / GRADE / REWRITE / WEB, per sub-query ───────────────────────
  const outcomes: SubQueryOutcome[] = [];
  const evidence = new Map<string, RetrievedChunk>();
  const webResults: WebResult[] = [];
  const globallyTriedQueries: string[] = [];

  for (const subQuery of activeSubQueries) {
    let currentQuery = subQuery.query;
    const attempts: RetrievalAttempt[] = [];
    const kept: RetrievedChunk[] = [];
    let resolved = false;
    let usedWebFallback = false;

    for (let attempt = 0; attempt <= budget.maxRewritesPerSubQuery; attempt += 1) {
      globallyTriedQueries.push(currentQuery);

      emit('retrieve', `searching: ${currentQuery}`, { attempt: attempt + 1 });
      const retrieved = await options.retriever.search(currentQuery, {
        topK: options.topK,
        minScore: options.minScore,
      });
      emit('retrieve', `${retrieved.length} passage(s) above threshold`, {
        topScore: Number((retrieved[0]?.score ?? 0).toFixed(3)),
      });

      const grade = await gradeChunks({
        model: options.graderModel,
        query: currentQuery,
        chunks: retrieved,
        ...signalOpt,
      });

      attempts.push({
        query: currentQuery,
        retrieved: retrieved.length,
        grade: {
          relevantCount: grade.relevantCount,
          partialCount: grade.partialCount,
          irrelevantCount: grade.irrelevantCount,
          sufficient: grade.sufficient,
        },
      });

      emit(
        'grade',
        `relevant=${grade.relevantCount} partial=${grade.partialCount} irrelevant=${grade.irrelevantCount}`,
        { sufficient: grade.sufficient, degraded: grade.degraded },
      );

      for (const chunk of grade.kept) {
        kept.push(chunk);
        const existing = evidence.get(chunk.id);
        if (existing === undefined || chunk.score > existing.score) evidence.set(chunk.id, chunk);
      }

      if (grade.sufficient) {
        resolved = true;
        break;
      }

      if (attempt === budget.maxRewritesPerSubQuery) {
        emit('rewrite', 'rewrite budget spent for this sub-query');
        break;
      }

      const failureReason =
        retrieved.length === 0
          ? 'retrieval returned no passages above the relevance threshold'
          : `${grade.irrelevantCount} of ${retrieved.length} passages were graded irrelevant and the rest do not answer the query`;

      const rewrite = await rewriteQuery({
        model: options.graderModel,
        originalQuestion: options.question,
        failedQuery: currentQuery,
        triedQueries: globallyTriedQueries,
        failureReason,
        ...signalOpt,
      });

      if (!rewrite.progressed) {
        emit('rewrite', `no further reformulation available (${rewrite.reasoning})`);
        break;
      }

      emit('rewrite', `${rewrite.strategy}: "${rewrite.query}"`, { reasoning: rewrite.reasoning });
      currentQuery = rewrite.query;
    }

    // ── WEB FALLBACK ────────────────────────────────────────────────────────
    if (!resolved) {
      emit('web-search', `local corpus insufficient for "${subQuery.query}"; trying ${options.webSearch.mode}`);
      const outcome = await options.webSearch.search(subQuery.query, {
        maxResults: 3,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });

      if (outcome.failure !== undefined) {
        emit('web-search', `unavailable: ${outcome.failure}`);
      } else if (outcome.results.length === 0) {
        emit('web-search', 'no web results');
      } else {
        usedWebFallback = true;
        for (const result of outcome.results) {
          if (!webResults.some((existing) => existing.url === result.url)) webResults.push(result);
        }
        emit('web-search', `${outcome.results.length} web result(s)`, {
          urls: outcome.results.map((result) => result.url),
        });
      }
    }

    outcomes.push({ query: subQuery.query, attempts, kept, resolved, usedWebFallback });
  }

  // ── GENERATE ──────────────────────────────────────────────────────────────
  const localEvidence = [...evidence.values()].sort((a, b) => b.score - a.score);

  if (localEvidence.length === 0 && webResults.length === 0) {
    // Nothing survived anywhere. Abstaining here is not a failure of the
    // workflow, it is the workflow working: no evidence, no answer.
    emit('done', 'no evidence from any source; abstaining');
    const answer = `INSUFFICIENT_CONTEXT: neither the local index nor the ${options.webSearch.mode} web fallback produced evidence for "${options.question}".`;

    return {
      answer,
      plan,
      subQueries: outcomes,
      citations: [],
      webResults: [],
      verification: {
        grounded: true,
        confident: true,
        audit: { used: [], unknown: [], unused: [], uncitedSentences: [], ok: true },
        unsupportedClaims: [],
        reason: 'An abstention asserts nothing, so there is nothing to verify.',
        tier: 'deterministic',
      },
      repaired: false,
      abstained: true,
      events,
      usage: { inputTokens, outputTokens },
      durationMs: Date.now() - startedAt,
    };
  }

  // Reserve budget for web sources so a large local context cannot squeeze out
  // the very evidence we fell back to fetch.
  const webBudget = webResults.length > 0 ? Math.min(600, Math.floor(options.maxContextTokens * 0.3)) : 0;
  const localBudget = options.maxContextTokens - webBudget;

  const localContext = assembleContext(localEvidence, { maxTokens: localBudget });
  const web = renderWebSources(webResults, localContext.blocks.length + 1);
  const allCitations: readonly Citation[] = [...localContext.citations, ...web.citations];

  emit('generate', `answering from ${allCitations.length} source(s)`, {
    local: localContext.blocks.length,
    web: web.citations.length,
    contextTokens: localContext.tokensUsed,
    degraded: localContext.degraded,
  });

  let generation = await generateGroundedAnswer({
    model: options.chatModel,
    question: options.question,
    chunks: localEvidence,
    maxContextTokens: localBudget,
    ...(web.text.length > 0 ? { extraContextText: web.text, extraCitations: web.citations } : {}),
    ...signalOpt,
  });

  inputTokens += generation.usage.inputTokens;
  outputTokens += generation.usage.outputTokens;

  const fullContextText =
    web.text.length > 0
      ? [generation.context.contextText, web.text].filter((part) => part.length > 0).join('\n\n')
      : generation.context.contextText;

  // ── VERIFY (+ bounded REPAIR loop) ────────────────────────────────────────
  let verification = await verifyAnswer({
    model: options.graderModel,
    question: options.question,
    answer: generation.answer,
    contextText: fullContextText,
    citations: allCitations,
    ...signalOpt,
  });

  emit('verify', verification.grounded ? 'answer is grounded' : `not grounded: ${verification.reason}`, {
    tier: verification.tier,
    confident: verification.confident,
    unsupported: verification.unsupportedClaims.length,
  });

  let repaired = false;

  for (let repair = 0; repair < budget.maxRepairs; repair += 1) {
    // Only repair a *confident* failure. If verification could not run, another
    // generation pass cannot fix anything and would just burn tokens.
    if (verification.grounded || !verification.confident) break;

    emit('repair', `regenerating to remove ${verification.unsupportedClaims.length} unsupported claim(s)`, {
      attempt: repair + 1,
    });

    const directive = buildRepairDirective(verification);

    generation = await generateGroundedAnswer({
      model: options.chatModel,
      // The directive is appended to the question rather than the instructions:
      // the grounding contract must stay byte-identical across passes so it
      // remains prompt-cacheable, and so the repair cannot weaken it.
      question: `${options.question}\n\n---\n${directive}`,
      chunks: localEvidence,
      maxContextTokens: localBudget,
      ...(web.text.length > 0 ? { extraContextText: web.text, extraCitations: web.citations } : {}),
      ...signalOpt,
    });

    inputTokens += generation.usage.inputTokens;
    outputTokens += generation.usage.outputTokens;
    repaired = true;

    verification = await verifyAnswer({
      model: options.graderModel,
      question: options.question,
      answer: generation.answer,
      contextText: fullContextText,
      citations: allCitations,
      ...signalOpt,
    });

    emit('verify', verification.grounded ? 'repaired answer is grounded' : `still not grounded: ${verification.reason}`, {
      tier: verification.tier,
      unsupported: verification.unsupportedClaims.length,
    });
  }

  emit('done', verification.grounded ? 'verified' : 'returning unverified answer with warnings', {
    repaired,
    abstained: generation.abstained,
  });

  return {
    answer: generation.answer,
    plan,
    subQueries: outcomes,
    citations: allCitations,
    webResults,
    verification,
    repaired,
    abstained: generation.abstained,
    events,
    usage: { inputTokens, outputTokens },
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Guard against a misconfigured budget producing an unbounded run. Called by the
 * CLI before starting, so a bad `.env` fails in milliseconds rather than after
 * forty model calls.
 */
export function assertBudgetSane(budget: WorkflowBudget): void {
  const worstCaseRetrievals = budget.maxSubQueries * (1 + budget.maxRewritesPerSubQuery);
  const worstCaseGenerations = 1 + budget.maxRepairs;

  if (worstCaseRetrievals > 24 || worstCaseGenerations > 4) {
    throw new LocalMindError(
      'CONFIG_INVALID',
      `Workflow budget allows up to ${worstCaseRetrievals} retrievals and ${worstCaseGenerations} generations per question.`,
      {
        remedy: 'Lower maxSubQueries or maxRewritesPerSubQuery. The defaults (3 x 3 retrievals, 2 generations) are sane.',
        details: { worstCaseRetrievals, worstCaseGenerations },
      },
    );
  }
}
