import { join, resolve } from 'node:path';

import { style } from '../core/ansi';
import { fileExists } from '../core/fs';
import { loadConfig, describeConfig } from '../core/config';
import { reportFatal } from '../core/errors';
import { LocalMind } from '../localmind';
import { createStudioRouter } from '../studio/router';

import { flagBoolean, flagNumber, flagString, parseArgs } from './shared';

/**
 * `bun run studio [--port 4141] [--client <dir>] [--api-only]`
 *
 * Serves the Studio: the JSON/SSE API plus the built SPA.
 *
 * TWO MODES, AND WHY BOTH EXIST
 *
 *  - Production / demo: the SPA is prebuilt into `dist/studio/client` and served
 *    from this one process. One port, no CORS, nothing to configure.
 *  - Development: run this with `--api-only` and Vite separately. Vite proxies
 *    `/api` here, so you get hot module reloading on the UI while the API keeps
 *    its LanceDB handles open.
 *
 * The client directory is resolved by *looking* for it rather than assuming,
 * because the same file runs from `src/` during development and from `dist/`
 * after a build, and those have different relative layouts.
 */

async function resolveClientDir(explicit: string | undefined): Promise<{ dir: string; found: boolean }> {
  if (explicit !== undefined) {
    const dir = resolve(explicit);
    return { dir, found: await fileExists(join(dir, 'index.html')) };
  }

  const here = import.meta.dir;
  const candidates = [
    // Installed package: dist/cli/studio.js -> dist/studio/client
    join(here, '..', 'studio', 'client'),
    // Running from source: src/cli/studio.ts -> <root>/dist/studio/client
    join(here, '..', '..', 'dist', 'studio', 'client'),
  ];

  for (const candidate of candidates) {
    if (await fileExists(join(candidate, 'index.html'))) return { dir: resolve(candidate), found: true };
  }

  return { dir: resolve(candidates[1] ?? candidates[0] ?? '.'), found: false };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const port = flagNumber(args, 'port') ?? 4141;
  const apiOnly = flagBoolean(args, 'api-only');
  const { dir: clientDir, found } = await resolveClientDir(flagString(args, 'client'));

  const config = loadConfig();

  process.stderr.write(`${style.bold('LocalMind Studio')}  ${style.dim(describeConfig(config))}\n`);

  // Opened eagerly so a misconfiguration fails now, at startup, rather than on
  // the first request from a user who then has to read a browser console.
  const mind = await LocalMind.open();
  const stats = await mind.corpus.stats();

  process.stderr.write(
    `${style.dim('corpus')}  ${stats.documents} document(s), ${stats.chunks} chunk(s), ${stats.dimensions}d\n`,
  );

  if (apiOnly) {
    process.stderr.write(`${style.dim('mode')}    API only\n`);
  } else if (found) {
    process.stderr.write(`${style.dim('client')}  ${clientDir}\n`);
  } else {
    process.stderr.write(
      `${style.yellow('client')}  not built — API will serve a 503 for UI routes\n` +
        `        ${style.dim(`run \`bun run studio:build\`, or \`bun run studio:dev\` for hot reload`)}\n`,
    );
  }

  const app = createStudioRouter({
    mind,
    clientDir,
    serveClient: !apiOnly && found,
  });

  const server = Bun.serve({ port, fetch: app.fetch, idleTimeout: 255 });

  process.stderr.write(
    `\n${style.green('ready')}   ${style.bold(`http://localhost:${server.port}`)}` +
      `${apiOnly || !found ? style.dim('  (api)') : ''}\n\n`,
  );

  const shutdown = async (): Promise<void> => {
    process.stderr.write(`\n${style.dim('shutting down…')}\n`);
    await server.stop(true);
    await mind.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch(reportFatal);
