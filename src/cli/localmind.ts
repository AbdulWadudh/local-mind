#!/usr/bin/env bun
import { style } from '../core/ansi';
import { reportFatal } from '../core/errors';

/**
 * The `localmind` binary: a subcommand dispatcher.
 *
 * One `bin` entry rather than seven, because a published package that installs
 * `ingest`, `search`, `ask`, `agent` and `research` onto a user's PATH would be
 * antisocial — those are words other tools own.
 *
 * Subcommands are loaded with a dynamic import so that `localmind --help` does
 * not pay for LanceDB, the AI SDK, or a provider registry.
 */

const COMMANDS: Readonly<Record<string, { readonly module: string; readonly summary: string }>> = {
  doctor: { module: './doctor.js', summary: 'Preflight: providers, models, corpus, index compatibility' },
  ingest: { module: './ingest.js', summary: 'Build the index from the corpus directory' },
  search: { module: './search.js', summary: 'Retrieval only — the first thing to run when an answer looks wrong' },
  ask: { module: './ask.js', summary: 'Stage 2 — grounded, streamed, cited answer' },
  agent: { module: './agent.js', summary: 'Stage 3 — the model decides what to retrieve' },
  research: { module: './research.js', summary: 'Stage 4 — plan, grade, self-correct, verify' },
  studio: { module: './studio.js', summary: 'Serve the Studio UI and API' },
};

function usage(): void {
  process.stderr.write(
    [
      `${style.bold('localmind')} — local-first agentic RAG`,
      '',
      `${style.dim('usage:')} localmind <command> [args]`,
      '',
      ...Object.entries(COMMANDS).map(
        ([name, entry]) => `  ${style.cyan(name.padEnd(9))} ${entry.summary}`,
      ),
      '',
      `${style.dim('examples:')}`,
      '  localmind doctor',
      '  localmind ingest --rebuild',
      '  localmind search "cosine distance" --top-k 5',
      '  localmind research "how are retries configured?"',
      '  localmind studio --port 4141',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    usage();
    process.exit(command === undefined ? 1 : 0);
  }

  const entry = COMMANDS[command];
  if (entry === undefined) {
    process.stderr.write(`${style.red(`unknown command "${command}"`)}\n\n`);
    usage();
    process.exit(1);
  }

  // Subcommand modules read `process.argv.slice(2)` themselves, so drop the
  // command word to keep their argument parsing identical to the dev scripts.
  process.argv = [process.argv[0] ?? 'node', process.argv[1] ?? 'localmind', ...process.argv.slice(3)];

  const specifier = entry.module;
  await import(specifier);
}

main().catch(reportFatal);
