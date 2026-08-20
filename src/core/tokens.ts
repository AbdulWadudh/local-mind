/**
 * Token accounting without a tokenizer dependency.
 *
 * A real tokenizer is provider-specific and would drag a WASM blob into a
 * zero-cloud-dependency project. Instead we over-estimate deliberately: the
 * numbers here are only ever used to decide *how much context to drop*, and an
 * over-estimate fails safe (you send less than the budget), while an
 * under-estimate fails loud (provider-side 400 mid-stream).
 */

/**
 * Upper-bound estimate. Takes the max of two heuristics because they fail in
 * opposite directions: chars/4 under-counts CJK and dense code, words*1.35
 * under-counts long identifiers and punctuation-heavy markdown.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const byChars = Math.ceil(text.length / 4);
  const words = text.trim().split(/\s+/u).length;
  const byWords = Math.ceil(words * 1.35);
  return Math.max(byChars, byWords, 1);
}

/**
 * Marker appended to truncated text.
 *
 * It costs tokens, so it has to be part of the budget rather than added after
 * it. Appending it post-check is a real bug that ships easily: the overshoot is
 * small enough (a handful of tokens) that it only bites at the exact moment the
 * budget matters, which is when the context window is already full.
 */
const TRUNCATION_MARKER = '\n[... truncated ...]';

/**
 * Hard-truncate to an approximate token budget, on a word boundary.
 *
 * Post-condition: `estimateTokens(result.text) <= maxTokens`, always. The final
 * loop enforces it on the assembled string, marker included, rather than
 * trusting the arithmetic that produced it.
 */
export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (maxTokens <= 0) return { text: '', truncated: text.length > 0 };
  if (estimateTokens(text) <= maxTokens) return { text, truncated: false };

  const markerTokens = estimateTokens(TRUNCATION_MARKER);

  // Not enough room for even the marker: return an empty string rather than a
  // string that is nothing but the marker.
  if (maxTokens <= markerTokens) return { text: '', truncated: true };

  const target = maxTokens - markerTokens;

  // 4 chars/token is the looser of the two heuristics, so start from it and
  // shrink until the stricter estimate also agrees.
  let end = Math.min(text.length, target * 4);
  let body = text.slice(0, end);
  while (end > 0 && estimateTokens(body) > target) {
    end = Math.floor(end * 0.9);
    body = text.slice(0, end);
  }

  // Prefer a word boundary, but only if it does not throw away most of the slice.
  const lastBreak = body.lastIndexOf(' ');
  if (lastBreak > body.length * 0.6) body = body.slice(0, lastBreak);

  let result = `${body.trimEnd()}${TRUNCATION_MARKER}`;

  // Enforce the post-condition on the final string.
  while (body.length > 0 && estimateTokens(result) > maxTokens) {
    body = body.slice(0, Math.floor(body.length * 0.9));
    result = `${body.trimEnd()}${TRUNCATION_MARKER}`;
  }

  return { text: result, truncated: true };
}

export interface Budget {
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
}

/** A tiny mutable accumulator so context assembly reads declaratively. */
export function createBudget(limit: number): {
  tryConsume(tokens: number): boolean;
  snapshot(): Budget;
} {
  let used = 0;
  return {
    tryConsume(tokens: number): boolean {
      if (used + tokens > limit) return false;
      used += tokens;
      return true;
    },
    snapshot(): Budget {
      return { limit, used, remaining: Math.max(0, limit - used) };
    },
  };
}
