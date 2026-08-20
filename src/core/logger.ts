import { style } from './ansi';

/**
 * A dependency-free structured logger with two output modes:
 *   - human (default)                : coloured, readable in a terminal
 *   - json  (LOCALMIND_LOG=json)     : one JSON object per line, for piping
 *
 * Everything diagnostic goes to stderr; only answer text goes to stdout via
 * `writeOut`. That separation is what lets `bun run ask "..." > answer.md`
 * produce a clean file while you still watch the trace on screen.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

const PAINT: Readonly<Record<LogLevel, (s: string) => string>> = {
  debug: style.grey,
  info: style.cyan,
  warn: style.yellow,
  error: style.red,
};

function resolveMinLevel(): LogLevel {
  const raw = (process.env['LOCALMIND_LOG_LEVEL'] ?? 'info').toLowerCase();
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info';
}

const MIN_LEVEL = resolveMinLevel();
const JSON_MODE = (process.env['LOCALMIND_LOG'] ?? '').toLowerCase() === 'json';

export interface Logger {
  readonly scope: string;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

function formatValue(value: unknown): string {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(4);
  if (typeof value === 'string') return /\s/.test(value) ? JSON.stringify(value) : value;
  if (value === null || value === undefined) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function emit(scope: string, level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;

  if (JSON_MODE) {
    process.stderr.write(
      `${JSON.stringify({ ts: new Date().toISOString(), level, scope, message, ...(fields ?? {}) })}\n`,
    );
    return;
  }

  const entries = Object.entries(fields ?? {});
  const tail =
    entries.length === 0 ? '' : ` ${style.dim(entries.map(([k, v]) => `${k}=${formatValue(v)}`).join(' '))}`;

  process.stderr.write(`${PAINT[level](level.padEnd(5))} ${style.dim(scope)} ${message}${tail}\n`);
}

export function createLogger(scope: string): Logger {
  return {
    scope,
    debug: (message, fields) => emit(scope, 'debug', message, fields),
    info: (message, fields) => emit(scope, 'info', message, fields),
    warn: (message, fields) => emit(scope, 'warn', message, fields),
    error: (message, fields) => emit(scope, 'error', message, fields),
    child: (childScope) => createLogger(`${scope}:${childScope}`),
  };
}

/** stdout, unstyled: content the user actually asked for. */
export function writeOut(text: string): void {
  process.stdout.write(text);
}
