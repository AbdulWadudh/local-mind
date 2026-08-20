import { ToolLoopAgent, hasToolCall, isStepCount } from 'ai';
import type { LanguageModel } from 'ai';

import { LocalMindError, describeUnknownError } from '../core/errors';
import { createLogger } from '../core/logger';
import type { Citation, RetrievedChunk, Retriever } from '../core/types';
import { auditCitations, normaliseCitationMarkers } from '../retrieval/context';
import type { CitationAudit } from '../retrieval/context';
import { generateGroundedAnswer } from '../generation/grounded-answer';

import { FINAL_ANSWER_TOOL, createRetrievalTools } from './tools';
import type { FinalAnswerOutput } from './tools';
import { createAgentTrace } from './trace';
import type { SearchRecord } from './trace';

/**
 * STAGE 3 - DELEGATE
 *
 * The agentic loop.
 *
 * `ToolLoopAgent` is the AI SDK's own loop: call the model, execute any tools it
 * requested, feed the results back, repeat until a stop condition fires. We use
 * it directly rather than wrapping it in a framework, so the only control-flow
 * concepts in play are the ones the SDK actually has: `tools`, `stopWhen`,
 * `prepareStep`, `onStepFinish`.
 *
 * STOPPING IS THE WHOLE PROBLEM
 * An agent loop has exactly one catastrophic failure mode - not stopping - and
 * three ways to reach it: the model never calls the terminal tool; it repeats a
 * failing query; or it interleaves text and tool calls forever. So there are
 * three independent brakes, and the run reports which one engaged:
 *
 *   1. `hasToolCall('finalAnswer')` - the intended exit.
 *   2. `isStepCount(maxSteps)`      - the wall-clock/cost backstop.
 *   3. The retrieval budget + repeat detection inside the tools themselves,
 *      which apply pressure toward (1) before (2) is reached.
 *
 * AND A FOURTH BRAKE, BELOW THE LOOP
 * If the loop ends without a committed answer, we do not fail. The trace already
 * holds every passage the agent retrieved, so we fall back to a plain Stage 2
 * grounded generation over that evidence. A partially-successful agent run still
 * produces a cited answer; only a *retrieval* failure produces nothing.
 */

const log = createLogger('agent:loop');

export const AGENT_INSTRUCTIONS = `You are LocalMind, a research assistant with access to a local knowledge base.

You cannot see the knowledge base directly. You must retrieve from it with the
searchKnowledgeBase tool, then answer strictly from what you retrieve.

## Procedure

1. Decompose. If the question contains several distinct sub-questions, search for
   each one separately. One topic per search call.
2. Translate. Search with the terminology the documentation would use, not the
   user's phrasing. "why is it so slow" is a bad query; "query latency index
   configuration" is a good one.
3. Assess. Look at the relevance score on each hit. Scores near the threshold
   mean the passage is tangential; scores above ~0.5 mean it is on-topic.
4. Reformulate, never repeat. If a query returns nothing useful, change the
   terms. The tool will refuse a query you have already run.
5. Commit. As soon as you can answer, call ${FINAL_ANSWER_TOOL}. Do not keep
   searching for corroboration you do not need.

## Rules

- Closed world: use only retrieved passages. Never answer from your own
  knowledge, even when you are confident.
- Every factual sentence in the final answer must end with a citation label such
  as [S1] or [S2][S3]. Only use labels returned by the tools.
- If the knowledge base does not contain the answer, call ${FINAL_ANSWER_TOOL}
  with confidence "insufficient" and state exactly which fact is missing. Do not
  guess, and do not pad with generic advice.
- No preamble. No "Based on the search results". Answer directly.`;

export type AgentStopReason =
  | 'final-answer-tool'
  | 'model-emitted-text'
  | 'step-limit'
  | 'fallback-synthesis';

export interface AgentRunResult {
  readonly answer: string;
  readonly confidence: FinalAnswerOutput['confidence'] | 'unknown';
  readonly citations: readonly Citation[];
  readonly evidence: readonly RetrievedChunk[];
  readonly audit: CitationAudit;
  readonly searches: readonly SearchRecord[];
  readonly steps: number;
  readonly stopReason: AgentStopReason;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly durationMs: number;
}

export interface RunRetrievalAgentOptions {
  readonly model: LanguageModel;
  readonly retriever: Retriever;
  readonly question: string;
  readonly maxSteps: number;
  readonly topK: number;
  readonly minScore: number;
  readonly maxContextTokens: number;
  readonly signal?: AbortSignal;
  readonly onStep?: (info: { step: number; toolCalls: readonly string[]; text: string }) => void;
}

export async function runRetrievalAgent(options: RunRetrievalAgentOptions): Promise<AgentRunResult> {
  const startedAt = Date.now();

  // Retrieval budget: generous enough for a 3-part question, tight enough that
  // a confused model cannot spend twenty calls. Leave headroom for the final
  // answering step, which also consumes a step from the loop.
  const maxSearches = Math.max(2, Math.min(options.maxSteps - 1, 6));

  const trace = createAgentTrace({ maxSearches });
  const tools = createRetrievalTools({
    retriever: options.retriever,
    trace,
    defaultTopK: options.topK,
    minScore: options.minScore,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  const agent = new ToolLoopAgent({
    model: options.model,
    instructions: AGENT_INSTRUCTIONS,
    tools,
    temperature: 0.1,
    // Both brakes are passed as an array: whichever fires first wins.
    stopWhen: [hasToolCall(FINAL_ANSWER_TOOL), isStepCount(options.maxSteps)],
    /**
     * `prepareStep` runs before each model call, which makes it the right place
     * for pressure that depends on how far the run has gone. Here: once the
     * retrieval budget is gone, we remove the search tools from the request
     * entirely via `activeTools`. Telling a model "stop searching" is a
     * suggestion; removing the tool is a guarantee.
     */
    prepareStep: ({ steps }) => {
      const exhausted = trace.remainingSearches() === 0;
      const nearLimit = steps.length >= options.maxSteps - 2;
      if (exhausted || nearLimit) {
        return { activeTools: [FINAL_ANSWER_TOOL] as const };
      }
      return {};
    },
    onStepFinish: (step) => {
      // Report the step that just *finished*, then advance. `trace.currentStep()`
      // means "the step now executing", which is what the tools recorded their
      // searches under, so reading it before bumping keeps the two logs aligned.
      const completed = trace.currentStep();
      trace.bumpStep();

      const toolNames = step.toolCalls.map((call) => call.toolName);
      log.info('step', {
        n: completed,
        tools: toolNames.join(',') || 'none',
        textChars: step.text.length,
      });
      options.onStep?.({ step: completed, toolCalls: toolNames, text: step.text });
    },
  });

  let result: Awaited<ReturnType<typeof agent.generate>>;
  try {
    result = await agent.generate({
      prompt: options.question,
      ...(options.signal !== undefined ? { abortSignal: options.signal } : {}),
    });
  } catch (error) {
    throw new LocalMindError('MODEL_CALL_FAILED', `Agent run failed: ${describeUnknownError(error)}`, {
      remedy:
        'If the chat model is local, confirm it supports tool calling (`llama3.1:8b`, `qwen3`, `mistral-nemo` do; many small models do not). Otherwise set LOCALMIND_CHAT_PROVIDER=openrouter.',
      details: { question: options.question.slice(0, 120) },
      cause: error,
    });
  }

  const usage = {
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
  };
  const steps = result.steps.length;
  const citations = trace.citations();
  const evidence = trace.evidence();

  // Did the model commit through the terminal tool? `toolResults` accumulates
  // across every step in AI SDK 7, so this finds the call wherever it happened.
  const finalCall = result.toolResults.find((entry) => entry.toolName === FINAL_ANSWER_TOOL);

  if (finalCall !== undefined) {
    const output = finalCall.output as FinalAnswerOutput;
    const answer = output.answer.trim();

    log.info('agent committed via tool', {
      confidence: output.confidence,
      steps,
      searches: trace.searches().length,
    });

    return {
      answer: normaliseCitationMarkers(
        answer,
        citations.map((citation) => citation.label),
      ),
      confidence: output.confidence,
      citations,
      evidence,
      audit: auditCitations(answer, citations),
      searches: trace.searches(),
      steps,
      stopReason: 'final-answer-tool',
      usage,
      durationMs: Date.now() - startedAt,
    };
  }

  // The model produced prose instead of calling the terminal tool. Common on
  // small local models; the text is usually a perfectly good answer.
  const text = result.text.trim();
  if (text.length > 0) {
    log.warn('agent ended with text instead of the final-answer tool', { steps });
    return {
      answer: normaliseCitationMarkers(
        text,
        citations.map((citation) => citation.label),
      ),
      confidence: 'unknown',
      citations,
      evidence,
      audit: auditCitations(text, citations),
      searches: trace.searches(),
      steps,
      stopReason: steps >= options.maxSteps ? 'step-limit' : 'model-emitted-text',
      usage,
      durationMs: Date.now() - startedAt,
    };
  }

  // BRAKE 4: no committed answer and no text. Synthesise from what was
  // retrieved rather than failing the run.
  log.warn('agent produced no answer; falling back to grounded synthesis', {
    steps,
    evidence: evidence.length,
  });

  if (evidence.length === 0) {
    throw new LocalMindError('AGENT_LOOP_EXHAUSTED', `The agent finished ${steps} steps without retrieving anything.`, {
      remedy:
        'The model is probably not emitting valid tool calls. Verify with `bun run ask "<question>"` (Stage 2, no tools). If that works, switch to a tool-capable chat model.',
      details: { steps, searches: trace.searches().length },
    });
  }

  const fallback = await generateGroundedAnswer({
    model: options.model,
    question: options.question,
    chunks: evidence,
    maxContextTokens: options.maxContextTokens,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  return {
    answer: fallback.answer,
    confidence: fallback.abstained ? 'insufficient' : 'low',
    citations: fallback.citations,
    evidence,
    audit: fallback.audit,
    searches: trace.searches(),
    steps,
    stopReason: 'fallback-synthesis',
    usage: {
      inputTokens: usage.inputTokens + fallback.usage.inputTokens,
      outputTokens: usage.outputTokens + fallback.usage.outputTokens,
    },
    durationMs: Date.now() - startedAt,
  };
}
