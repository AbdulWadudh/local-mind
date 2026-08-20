import { style } from './ansi';

/**
 * A single, exhaustive error taxonomy for LocalMind.
 *
 * Why bother? Because every stage adds a new way for the pipeline to fail
 * *silently*: an embedding model whose dimensions changed, a chunk that no longer
 * fits the context window, a tool that returned malformed JSON. Typed errors with
 * a machine-readable `code` and a human-readable `remedy` turn silent failures
 * into actionable CLI output.
 */
export type LocalMindErrorCode =
  | 'CONFIG_INVALID'
  | 'PROVIDER_UNAVAILABLE'
  | 'CORPUS_EMPTY'
  | 'CORPUS_UNREADABLE'
  | 'CHUNKING_FAILED'
  | 'EMBEDDING_FAILED'
  | 'EMBEDDING_DIMENSION_MISMATCH'
  | 'VECTOR_STORE_FAILED'
  | 'INDEX_MISSING'
  | 'INDEX_MANIFEST_MISMATCH'
  | 'CONTEXT_BUDGET_EXCEEDED'
  | 'MODEL_CALL_FAILED'
  | 'STRUCTURED_OUTPUT_INVALID'
  | 'AGENT_LOOP_EXHAUSTED'
  | 'AGENT_LOOP_STALLED'
  | 'WEB_SEARCH_FAILED';

export class LocalMindError extends Error {
  readonly code: LocalMindErrorCode;
  /** A concrete next action for the operator. Printed by every CLI. */
  readonly remedy: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: LocalMindErrorCode,
    message: string,
    options: { remedy: string; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'LocalMindError';
    this.code = code;
    this.remedy = options.remedy;
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }

  static is(error: unknown): error is LocalMindError {
    return error instanceof LocalMindError;
  }
}

/** Narrow an unknown catch value to a printable message without losing detail. */
export function describeUnknownError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Print an error the way an operator wants to read it, then exit non-zero.
 * Every `cli-*.ts` entrypoint funnels here so error UX is identical.
 */
export function reportFatal(error: unknown): never {
  if (LocalMindError.is(error)) {
    process.stderr.write(`\n${style.red(`x ${error.code}`)} ${error.message}\n`);
    process.stderr.write(`  ${style.yellow(`-> ${error.remedy}`)}\n`);
    if (Object.keys(error.details).length > 0) {
      process.stderr.write(`  ${style.dim(`details: ${JSON.stringify(error.details)}`)}\n`);
    }
    if (error.cause !== undefined) {
      process.stderr.write(`  ${style.dim(`cause:   ${describeUnknownError(error.cause)}`)}\n`);
    }
  } else {
    process.stderr.write(`\n${style.red('x UNEXPECTED')} ${describeUnknownError(error)}\n`);
    if (error instanceof Error && error.stack !== undefined) {
      process.stderr.write(`${style.dim(error.stack)}\n`);
    }
  }
  process.stderr.write('\n');
  process.exit(1);
}
