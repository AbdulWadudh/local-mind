import { generateText, streamText } from 'ai';
import type { LanguageModel } from 'ai';

import { LocalMindError, describeUnknownError } from '../core/errors';
import { createLogger } from '../core/logger';
import { withRetry } from '../core/resilience';
import type { Citation, RetrievedChunk } from '../core/types';
import { assembleContext, auditCitations, normaliseCitationMarkers } from '../retrieval/context';
import type { AssembledContext, CitationAudit } from '../retrieval/context';

import {
  GROUNDED_ANSWER_INSTRUCTIONS,
  buildGroundedPrompt,
  isAbstention,
} from './prompt';

/**
 * STAGE 2 - GROUND
 *
 * Retrieved chunks in, cited answer out.
 *
 * Two entrypoints on purpose:
 *   - `streamGroundedAnswer` for interactive use. Time-to-first-token on a local
 *     8B model is 1-3 seconds; total generation can be 30. Streaming is not a
 *     nicety here, it is the difference between usable and abandoned.
 *   - `generateGroundedAnswer` for programmatic use. Stage 4 needs the complete
 *     text before it can verify it, so streaming would only add complexity.
 *
 * Both share one contract: the citation table is derived from the assembled
 * context, never from the model's output. The model can only *use* labels; it can
 * never *define* them. That asymmetry is what makes `auditCitations` meaningful.
 */

const log = createLogger('generation');

export interface GroundedAnswerInput {
  readonly model: LanguageModel;
  readonly question: string;
  readonly chunks: readonly RetrievedChunk[];
  readonly maxContextTokens: number;
  /** Extra sources (e.g. web results) already rendered into `<source>` tags. */
  readonly extraContextText?: string;
  readonly extraCitations?: readonly Citation[];
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

export interface GroundedAnswerResult {
  readonly answer: string;
  readonly citations: readonly Citation[];
  readonly context: AssembledContext;
  readonly audit: CitationAudit;
  readonly abstained: boolean;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly finishReason: string;
}

interface PreparedCall {
  readonly prompt: string;
  readonly context: AssembledContext;
  readonly citations: readonly Citation[];
}

function prepare(input: GroundedAnswerInput): PreparedCall {
  const context = assembleContext(input.chunks, { maxTokens: input.maxContextTokens });

  const extraText = input.extraContextText ?? '';
  const contextText =
    extraText.length > 0
      ? [context.contextText, extraText].filter((part) => part.length > 0).join('\n\n')
      : context.contextText;

  const citations: readonly Citation[] = [...context.citations, ...(input.extraCitations ?? [])];

  return {
    prompt: buildGroundedPrompt({ question: input.question, contextText }),
    context,
    citations,
  };
}

/**
 * Zero-source short circuit.
 *
 * When retrieval returns nothing, calling the model is pure waste: the correct
 * output is a deterministic abstention, and asking a model to produce it just
 * gives it an opportunity to answer from memory instead. Refusing in code is
 * both cheaper and strictly safer.
 */
function emptyContextResult(context: AssembledContext, question: string): GroundedAnswerResult {
  const answer = `INSUFFICIENT_CONTEXT: no indexed passage matched this question, so there is no evidence to answer "${question}".`;
  log.warn('no sources above threshold; abstaining without a model call');

  return {
    answer,
    citations: [],
    context,
    audit: { used: [], unknown: [], unused: [], uncitedSentences: [], ok: true },
    abstained: true,
    usage: { inputTokens: 0, outputTokens: 0 },
    finishReason: 'abstained-no-context',
  };
}

/** Non-streaming grounded generation. Used by Stage 4 and the test harness. */
export async function generateGroundedAnswer(input: GroundedAnswerInput): Promise<GroundedAnswerResult> {
  const { prompt, context, citations } = prepare(input);

  if (citations.length === 0) return emptyContextResult(context, input.question);

  const result = await withRetry(
    () =>
      generateText({
        model: input.model,
        instructions: GROUNDED_ANSWER_INSTRUCTIONS,
        prompt,
        temperature: input.temperature ?? 0.1,
        ...(input.signal !== undefined ? { abortSignal: input.signal } : {}),
      }),
    { label: 'generateGroundedAnswer', attempts: 2 },
  );

  // Normalised at the boundary, so every consumer — the audit, the Studio, the
  // verifier, a library user — sees the same canonical `[Sn]` markers. Doing it
  // once here beats each of them re-implementing the tolerance.
  const answer = normaliseCitationMarkers(
    result.text.trim(),
    citations.map((citation) => citation.label),
  );
  const audit = auditCitations(answer, citations);

  if (!audit.ok) {
    log.warn('citation audit found problems', {
      unknownLabels: audit.unknown.length,
      uncitedSentences: audit.uncitedSentences.length,
    });
  }

  return {
    answer,
    citations,
    context,
    audit,
    abstained: isAbstention(answer),
    usage: {
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
    },
    finishReason: String(result.finishReason),
  };
}

export interface StreamedGroundedAnswer {
  readonly citations: readonly Citation[];
  readonly context: AssembledContext;
  /** Text deltas. Consume fully before awaiting `settled`. */
  readonly textStream: AsyncIterable<string>;
  /** Resolves after the stream is drained, with the same shape as the non-streaming call. */
  readonly settled: () => Promise<GroundedAnswerResult>;
}

/**
 * Streaming grounded generation.
 *
 * The returned object separates the stream from the settled result so a caller
 * can render tokens as they arrive and still get the citation audit afterwards.
 * `settled()` must be called after the stream is drained; it awaits the SDK's
 * own promises rather than re-accumulating text, so there is one source of truth.
 */
export function streamGroundedAnswer(input: GroundedAnswerInput): StreamedGroundedAnswer {
  const { prompt, context, citations } = prepare(input);

  if (citations.length === 0) {
    const fallback = emptyContextResult(context, input.question);
    return {
      citations: [],
      context,
      textStream: (async function* emit(): AsyncGenerator<string> {
        yield fallback.answer;
      })(),
      settled: () => Promise.resolve(fallback),
    };
  }

  const result = streamText({
    model: input.model,
    instructions: GROUNDED_ANSWER_INSTRUCTIONS,
    prompt,
    temperature: input.temperature ?? 0.1,
    ...(input.signal !== undefined ? { abortSignal: input.signal } : {}),
    onError: ({ error }) => {
      // streamText surfaces mid-stream failures here rather than throwing, so
      // without this handler a dropped connection looks like a short answer.
      log.error('stream failed mid-flight', { error: describeUnknownError(error) });
    },
  });

  return {
    citations,
    context,
    textStream: result.textStream,
    settled: async (): Promise<GroundedAnswerResult> => {
      try {
        const [answerRaw, usage, finishReason] = await Promise.all([
          result.text,
          result.usage,
          result.finishReason,
        ]);

        const answer = normaliseCitationMarkers(
          answerRaw.trim(),
          citations.map((citation) => citation.label),
        );
        return {
          answer,
          citations,
          context,
          audit: auditCitations(answer, citations),
          abstained: isAbstention(answer),
          usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
          finishReason: String(finishReason),
        };
      } catch (error) {
        throw new LocalMindError('MODEL_CALL_FAILED', `Streamed generation failed: ${describeUnknownError(error)}`, {
          remedy: 'Run `bun run doctor`. If the chat model is local, confirm it is pulled and that Ollama has enough free RAM.',
          cause: error,
        });
      }
    },
  };
}
