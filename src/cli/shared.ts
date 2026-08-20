import { style } from '../core/ansi';
import { describeConfig, loadConfig } from '../core/config';
import type { LocalMindConfig } from '../core/config';
import { LocalMindError, reportFatal } from '../core/errors';
import { writeOut } from '../core/logger';
import { createModelRegistry } from '../core/providers';
import type { ModelRegistry } from '../core/providers';

/**
 * Shared CLI plumbing: argument parsing, the banner, Ctrl-C handling, and a
 * single `main` wrapper so every entrypoint has identical error UX.
 */

export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

/**
 * Minimal argv parser. Supports `--flag`, `--key value`, `--key=value` and
 * positionals. Deliberately dependency-free; a CLI framework here would be more
 * code than the CLIs.
 */
export function parseArgs(argv: readonly string[] = process.argv.slice(2)): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;

    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const body = token.slice(2);
    const equals = body.indexOf('=');

    if (equals !== -1) {
      flags[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }

    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next;
      index += 1;
    } else {
      flags[body] = true;
    }
  }

  return { positionals, flags };
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const value = args.flags[name];
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function flagBoolean(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === 'true';
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

/** Require a question argument, with a usage message when absent. */
export function requireQuestion(args: ParsedArgs, usage: string): string {
  const question = args.positionals.join(' ').trim();
  if (question.length === 0) {
    throw new LocalMindError('CONFIG_INVALID', 'No question provided.', { remedy: `Usage: ${usage}` });
  }
  return question;
}

export function banner(stage: string, config: LocalMindConfig): void {
  process.stderr.write(`${style.bold(`LocalMind - ${stage}`)}  ${style.dim(describeConfig(config))}\n`);
}

export function heading(text: string): void {
  process.stderr.write(`\n${style.bold(text)}\n`);
}

/** Fixed-width, aligned key/value line for report output. */
export function kv(label: string, value: string, width = 18): void {
  process.stderr.write(`  ${style.dim(label.padEnd(width))} ${value}\n`);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export interface CliContext {
  readonly args: ParsedArgs;
  readonly config: LocalMindConfig;
  readonly registry: ModelRegistry;
  readonly signal: AbortSignal;
}

/**
 * Wrap a CLI body.
 *
 * Handles the three things every entrypoint needs and none of them should
 * re-implement: config loading, Ctrl-C mapping to an AbortSignal that is
 * threaded into every model call, and uniform fatal-error reporting.
 */
export async function runCli(
  stage: string,
  body: (context: CliContext) => Promise<void>,
  options: { readonly showBanner?: boolean } = {},
): Promise<void> {
  const args = parseArgs();
  const controller = new AbortController();

  const onInterrupt = (): void => {
    process.stderr.write(`\n${style.yellow('interrupted; cancelling in-flight requests...')}\n`);
    controller.abort();
  };
  process.once('SIGINT', onInterrupt);

  try {
    const config = loadConfig();
    if (options.showBanner !== false) banner(stage, config);
    const registry = createModelRegistry(config);
    await body({ args, config, registry, signal: controller.signal });
  } catch (error) {
    reportFatal(error);
  } finally {
    process.removeListener('SIGINT', onInterrupt);
  }
}

/** Render a citation table to stderr, so stdout stays pure answer text. */
export function printCitations(
  citations: readonly {
    label: string;
    title: string;
    relativePath: string;
    headingPath: string;
    score: number;
    origin: 'corpus' | 'web';
  }[],
  usedLabels?: readonly string[],
): void {
  if (citations.length === 0) return;

  heading('Sources');
  const used = usedLabels === undefined ? undefined : new Set(usedLabels);

  for (const citation of citations) {
    const marker = used === undefined ? ' ' : used.has(citation.label) ? style.green('*') : style.dim('-');
    const where = citation.headingPath.length > 0 ? ` ${style.dim(`> ${citation.headingPath}`)}` : '';
    const score =
      citation.origin === 'web' ? style.dim('web') : style.dim(citation.score.toFixed(3));
    process.stderr.write(
      `  ${marker} ${style.cyan(citation.label.padEnd(4))} ${score}  ${citation.title}${where}\n` +
        `        ${style.dim(citation.relativePath)}\n`,
    );
  }

  if (used !== undefined) {
    process.stderr.write(`  ${style.dim('* = cited in the answer')}\n`);
  }
}

/** Print the answer to stdout with a trailing newline. */
export function printAnswer(answer: string): void {
  writeOut(`${answer.trimEnd()}\n`);
}
