import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';

/**
 * Filesystem helpers, Bun-first.
 *
 * THE RULE THIS FILE ENCODES
 * Use a Bun API whenever one exists; fall back to `node:` only where Bun has no
 * equivalent. Centralising the handful of operations the library performs makes
 * that rule checkable — there is one place to look to see what still needs Node,
 * and why.
 *
 * BUN NATIVE (used directly, no wrapper needed):
 *   Bun.file(p).text() / .bytes() / .exists() / .size / .stat()
 *   Bun.write(p, data)          — also creates missing parent directories
 *   Bun.CryptoHasher            — replaces node:crypto createHash
 *   Bun.spawn                   — replaces node:child_process spawn
 *   Bun.$                       — replaces shelling out for rm -rf
 *   import.meta.dir             — replaces dirname(fileURLToPath(import.meta.url))
 *
 * STILL NODE, because Bun has no equivalent:
 *   node:path                   — no Bun path module
 *   node:os tmpdir              — no Bun temp-directory accessor
 *   node:fs/promises mkdtemp    — no Bun mktemp
 *   node:fs/promises readdir    — Bun.Glob yields paths, not directory entries,
 *                                 and the corpus/repository walkers need to know
 *                                 directory-vs-file *before* descending so they
 *                                 can prune node_modules and friends. Globbing
 *                                 the whole tree and filtering afterwards reads
 *                                 every ignored path, which on a large
 *                                 repository is the expensive part.
 *
 * Everything here is Bun-only. That is a deliberate trade: see the note in
 * README about running the library under Node.
 */

/** sha256 hex digest. `Bun.CryptoHasher` replaces `node:crypto`. */
export function sha256Hex(input: string): string {
  return new Bun.CryptoHasher('sha256').update(input, 'utf8').digest('hex');
}

/** Read a UTF-8 file. Returns undefined when it does not exist or is unreadable. */
export async function readTextOrUndefined(path: string): Promise<string | undefined> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return undefined;
    return await file.text();
  } catch {
    return undefined;
  }
}

/** Read a UTF-8 file, throwing the underlying error if it fails. */
export async function readText(path: string): Promise<string> {
  return Bun.file(path).text();
}

/** Read a file as bytes, for the static asset handler. */
export async function readBytes(path: string): Promise<Uint8Array> {
  return Bun.file(path).bytes();
}

/** Write UTF-8 text, creating parent directories as needed. */
export async function writeText(path: string, contents: string): Promise<void> {
  await Bun.write(path, contents);
}

export async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

export interface PathInfo {
  readonly exists: boolean;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly size: number;
}

/**
 * Stat a path without throwing.
 *
 * `Bun.file(dir).exists()` returns false for a directory, so directory checks
 * have to go through `stat()`. Wrapping both in one call keeps the callers from
 * having to remember that.
 */
export async function inspectPath(path: string): Promise<PathInfo> {
  try {
    const stat = await Bun.file(path).stat();
    return {
      exists: true,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      size: stat.size,
    };
  } catch {
    return { exists: false, isFile: false, isDirectory: false, size: 0 };
  }
}

/** Recursive delete. `Bun.$` is Bun's shell; `rm -rf` is implemented natively. */
export async function removeDirectory(path: string): Promise<void> {
  // `.nothrow()` because this is almost always called from a cleanup path where
  // a failure to delete must not mask the original error.
  await Bun.$`rm -rf ${path}`.quiet().nothrow();
}

/**
 * List directory entries with their types.
 *
 * The one genuinely Node-only operation the library performs. See the module
 * comment for why `Bun.Glob` is not a substitute here.
 */
export async function listEntries(path: string): Promise<Dirent[]> {
  return readdir(path, { withFileTypes: true });
}

export type { Dirent };

/**
 * Run a subprocess and capture its output.
 *
 * `Bun.spawn` replaces `node:child_process`. The timeout is enforced by racing
 * the exit promise, because a `git clone` against an unreachable host will
 * otherwise hang for the TCP timeout rather than the one we asked for.
 */
export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function run(
  command: readonly string[],
  options: { readonly cwd?: string; readonly env?: Record<string, string>; readonly timeoutMs?: number } = {},
): Promise<RunResult> {
  const proc = Bun.spawn([...command], {
    stdout: 'pipe',
    stderr: 'pipe',
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    env: { ...process.env, ...(options.env ?? {}) },
  });

  const timeoutMs = options.timeoutMs ?? 180_000;
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  try {
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    if (timedOut) {
      throw new Error(`${command[0] ?? 'command'} timed out after ${timeoutMs}ms`);
    }

    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
  } finally {
    clearTimeout(timer);
  }
}
