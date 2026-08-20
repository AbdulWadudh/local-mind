import { NoObjectGeneratedError, generateObject } from 'ai';
import type { LanguageModel } from 'ai';
import type { z } from 'zod';

import { LocalMindError, describeUnknownError } from './errors';
import { createLogger } from './logger';

/**
 * Defensive wrappers around model calls.
 *
 * Stage 4 issues one structured call per retrieval round, plus a
 * verification call per answer. At that volume, "the model emitted prose
 * instead of JSON" stops being a rare event and becomes a design constraint,
 * especially on small local models. Everything here exists so that a single
 * malformed response degrades one grade instead of aborting the pipeline.
 */

const log = createLogger('resilience');

export interface RetryOptions {
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly label: string;
}

/** Exponential backoff with jitter around any async model call. */
export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 400;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const delay = Math.round(baseDelayMs * 2 ** (attempt - 1) * (0.7 + Math.random() * 0.6));
      log.warn('retrying after failure', {
        label: options.label,
        attempt,
        attempts,
        delayMs: delay,
        error: describeUnknownError(error),
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new LocalMindError(
    'MODEL_CALL_FAILED',
    `${options.label} failed after ${attempts} attempts: ${describeUnknownError(lastError)}`,
    {
      remedy:
        'Check that the model is loaded and the endpoint is reachable (`bun run doctor`). On small local models, lower LOCALMIND_TOP_K so each request carries less context.',
      details: { label: options.label, attempts },
      cause: lastError,
    },
  );
}

export interface StructuredCallOptions<TSchema extends z.ZodType> {
  readonly model: LanguageModel;
  readonly schema: TSchema;
  readonly instructions: string;
  readonly prompt: string;
  readonly label: string;
  readonly attempts?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

export type StructuredResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string; readonly rawText?: string };

/**
 * `generateObject` that never throws.
 *
 * Callers decide what an unparseable response means for *their* node: the
 * relevance grader treats it as "unknown, keep the document" (fail open, so a
 * flaky grader cannot delete your evidence), while the groundedness verifier
 * treats it as "cannot confirm" (fail closed, so an unverified answer is never
 * presented as verified). Encoding that choice in a result type instead of an
 * exception is what keeps the Stage 4 state machine readable.
 */
export async function safeGenerateObject<TSchema extends z.ZodType>(
  options: StructuredCallOptions<TSchema>,
): Promise<StructuredResult<z.output<TSchema>>> {
  try {
    const result = await withRetry(
      () =>
        generateObject({
          model: options.model,
          schema: options.schema,
          instructions: options.instructions,
          prompt: options.prompt,
          temperature: options.temperature ?? 0,
          ...(options.signal !== undefined ? { abortSignal: options.signal } : {}),
        }),
      { label: options.label, attempts: options.attempts ?? 2 },
    );

    return { ok: true, value: result.object as z.output<TSchema> };
  } catch (error) {
    // `NoObjectGeneratedError` carries the raw text the model *did* produce,
    // which is the single most useful thing to log when a grader misbehaves.
    if (NoObjectGeneratedError.isInstance(error)) {
      log.warn('structured output unparseable', {
        label: options.label,
        text: error.text?.slice(0, 240) ?? '',
      });
      return {
        ok: false,
        error: 'model did not produce schema-valid JSON',
        ...(error.text !== undefined ? { rawText: error.text } : {}),
      };
    }

    log.warn('structured call failed', { label: options.label, error: describeUnknownError(error) });
    return { ok: false, error: describeUnknownError(error) };
  }
}
