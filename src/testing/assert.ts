import { style } from '../core/ansi';
import { describeUnknownError } from '../core/errors';

/**
 * A ~60-line test harness.
 *
 * Why not a test framework: the point of `bun run verify` is to be the *first*
 * thing a reader runs, before installing anything beyond the dependencies the
 * app itself needs. A framework would add a config file, a runner, and a set of
 * conventions to learn before the first green tick. This gives grouped output,
 * accurate pass/fail counts, and a non-zero exit code, which is the entirety of
 * what the harness needs to do.
 */

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

/**
 * Note the `asserts condition` return type: without it, every `assert(x !== undefined)`
 * in the harness would be followed by a TypeScript error on the next line. The
 * assertion signature makes the harness narrow types the same way a real test
 * framework does.
 */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionError(message);
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new AssertionError(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

export function assertIncludes(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new AssertionError(`${message} (expected to find ${JSON.stringify(needle)})`);
  }
}

export async function assertThrows(
  operation: () => Promise<unknown> | unknown,
  predicate: (error: unknown) => boolean,
  message: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (predicate(error)) return;
    throw new AssertionError(`${message} - threw the wrong error: ${describeUnknownError(error)}`);
  }
  throw new AssertionError(`${message} - nothing was thrown`);
}

interface Failure {
  readonly suite: string;
  readonly name: string;
  readonly error: string;
}

export interface Harness {
  suite(name: string): void;
  test(name: string, body: () => Promise<void> | void): Promise<void>;
  skip(name: string, reason: string): void;
  summary(): { passed: number; failed: number; skipped: number; failures: readonly Failure[] };
}

export function createHarness(): Harness {
  let currentSuite = 'default';
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures: Failure[] = [];

  return {
    suite(name: string): void {
      currentSuite = name;
      process.stderr.write(`\n${style.bold(name)}\n`);
    },

    async test(name: string, body: () => Promise<void> | void): Promise<void> {
      const startedAt = Date.now();
      try {
        await body();
        passed += 1;
        const elapsed = Date.now() - startedAt;
        const timing = elapsed > 50 ? style.dim(` ${elapsed}ms`) : '';
        process.stderr.write(`  ${style.green('pass')} ${name}${timing}\n`);
      } catch (error) {
        failed += 1;
        const message = error instanceof AssertionError ? error.message : describeUnknownError(error);
        failures.push({ suite: currentSuite, name, error: message });
        process.stderr.write(`  ${style.red('FAIL')} ${name}\n       ${style.red(message)}\n`);
      }
    },

    skip(name: string, reason: string): void {
      skipped += 1;
      process.stderr.write(`  ${style.yellow('skip')} ${name} ${style.dim(`(${reason})`)}\n`);
    },

    summary() {
      return { passed, failed, skipped, failures };
    },
  };
}
