// `mkdtemp` and `tmpdir` are the only Node calls left in this file: Bun has no
// temp-directory accessor and no mktemp. Everything else goes through core/fs.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, relative, sep } from 'node:path';

import { LocalMindError, describeUnknownError } from '../../core/errors';
import { inspectPath, listEntries, readText, removeDirectory, run } from '../../core/fs';
import type { Dirent } from '../../core/fs';
import { createLogger } from '../../core/logger';

/**
 * Getting a repository onto disk, and reading it sanely.
 *
 * WHY A SHALLOW CLONE RATHER THAN THE GITHUB API
 * The API costs one request per tree node and is rate limited to 60/hour
 * unauthenticated. A moderately sized repo blows through that before the
 * analyzer has read anything interesting. `git clone --depth 1` is one network
 * round trip, works on private repos with whatever credentials git already has,
 * and yields a filesystem - which is what every subsequent step wants anyway.
 *
 * WHY THE FILE FILTER IS SO AGGRESSIVE
 * The analyzer's budget is the model's context window, not the disk. A repo is
 * mostly lockfiles, snapshots, fixtures, build output and vendored code, none of
 * which tells you how the system works. Reading less, and reading the right
 * files, produces better documents than reading everything.
 */

const log = createLogger('sources:github:repo');

/** Directories that never contain architectural signal. */
const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules', '.git', '.github', 'dist', 'build', 'out', 'target', 'vendor',
  'coverage', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '__pycache__',
  '.venv', 'venv', 'env', '.tox', 'bin', 'obj', 'Pods', '.gradle', '.idea',
  '.vscode', '.terraform', 'site-packages', '.pytest_cache', '.mypy_cache',
  'fixtures', '__snapshots__', 'testdata', '.yarn', 'bower_components',
]);

const SKIP_FILE_PATTERNS: readonly RegExp[] = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/u,
  /\.(min|bundle|chunk)\.(js|css)$/u,
  /\.(map|snap|lock)$/u,
  /\.(png|jpe?g|gif|svg|ico|webp|avif|bmp|tiff?)$/u,
  /\.(woff2?|ttf|otf|eot)$/u,
  /\.(mp[34]|wav|ogg|webm|mov|avi)$/u,
  /\.(zip|tar|gz|tgz|bz2|xz|7z|rar|jar|war)$/u,
  /\.(pdf|docx?|xlsx?|pptx?)$/u,
  /\.(so|dylib|dll|exe|bin|wasm|node|pyc|class|o|a)$/u,
  /\.(pem|key|crt|p12|pfx)$/u,
];

/** Files worth reading whole, regardless of extension. */
const MANIFEST_FILES: ReadonlySet<string> = new Set([
  'package.json', 'tsconfig.json', 'deno.json', 'jsr.json',
  'requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile', 'environment.yml',
  'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'Gemfile', 'composer.json', 'mix.exs', 'pubspec.yaml', 'CMakeLists.txt',
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
  'Makefile', 'Procfile', 'vercel.json', 'netlify.toml', 'fly.toml', 'railway.json',
  'serverless.yml', 'serverless.yaml', 'template.yaml', 'samconfig.toml',
  'schema.prisma', 'drizzle.config.ts', 'knexfile.js', 'alembic.ini',
  'openapi.yaml', 'openapi.yml', 'openapi.json', 'swagger.yaml', 'swagger.json',
  '.env.example', '.env.sample', '.env.template', '.env.defaults',
  'README.md', 'ARCHITECTURE.md', 'CONTRIBUTING.md', 'DEPLOYMENT.md',
]);

const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.py', '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.rb', '.php',
  '.cs', '.fs', '.swift', '.m', '.mm', '.c', '.h', '.cc', '.cpp', '.hpp',
  '.ex', '.exs', '.erl', '.clj', '.hs', '.ml', '.dart', '.lua', '.sh', '.bash',
  '.sql', '.graphql', '.gql', '.proto', '.tf', '.tfvars', '.hcl',
  '.yaml', '.yml', '.toml', '.json', '.md', '.mdx', '.txt',
]);

/** Per-file read cap. A 400 KB source file is generated, not authored. */
const MAX_FILE_BYTES = 256 * 1024;
/** Total files inventoried. Beyond this the tree is sampled, not exhausted. */
const MAX_FILES = 4000;

export interface RepoFile {
  /** Path relative to the repository root, always with forward slashes. */
  readonly path: string;
  readonly bytes: number;
  readonly extension: string;
  readonly isManifest: boolean;
  readonly depth: number;
}

export interface Repository {
  /** `owner/name` when known, else the directory name. */
  readonly slug: string;
  readonly ref: string;
  readonly root: string;
  readonly files: readonly RepoFile[];
  readonly truncated: boolean;
  read(path: string): Promise<string>;
  /** Read several files, skipping unreadable ones. */
  readMany(paths: readonly string[]): Promise<Map<string, string>>;
  dispose(): Promise<void>;
}

async function runGit(args: readonly string[], cwd?: string, timeoutMs = 180_000): Promise<string> {
  const result = await run(['git', ...args], {
    ...(cwd !== undefined ? { cwd } : {}),
    // Never let git open a credential prompt: in a server process it would hang
    // for the full timeout instead of failing immediately.
    env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
    timeoutMs,
  });

  if (result.code !== 0) {
    throw new Error(result.stderr.length > 0 ? result.stderr : `git exited with code ${result.code}`);
  }
  return result.stdout;
}

function shouldSkipFile(path: string): boolean {
  return SKIP_FILE_PATTERNS.some((pattern) => pattern.test(path));
}

async function inventory(root: string): Promise<{ files: RepoFile[]; truncated: boolean }> {
  const files: RepoFile[] = [];
  let truncated = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (files.length >= MAX_FILES) {
      truncated = true;
      return;
    }

    let entries: Dirent[];
    try {
      entries = await listEntries(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }

      const absolute = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        // Allow dotfiles at the root (.github is skipped explicitly above) but
        // not nested hidden directories, which are almost always tool caches.
        if (entry.name.startsWith('.') && depth > 0) continue;
        await walk(absolute, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;

      const path = relative(root, absolute).split(sep).join('/');
      if (shouldSkipFile(path)) continue;

      const extension = extname(entry.name).toLowerCase();
      const isManifest = MANIFEST_FILES.has(entry.name);
      if (!isManifest && !CODE_EXTENSIONS.has(extension)) continue;

      const info = await inspectPath(absolute);
      if (!info.exists) continue;
      const bytes = info.size;
      if (bytes > MAX_FILE_BYTES && !isManifest) continue;

      files.push({ path, bytes, extension, isManifest, depth });
    }
  }

  await walk(root, 0);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, truncated };
}

function makeRepository(input: {
  slug: string;
  ref: string;
  root: string;
  files: RepoFile[];
  truncated: boolean;
  cleanup?: () => Promise<void>;
}): Repository {
  return {
    slug: input.slug,
    ref: input.ref,
    root: input.root,
    files: input.files,
    truncated: input.truncated,

    async read(path): Promise<string> {
      const content = await readText(join(input.root, path));
      return content.length > MAX_FILE_BYTES ? `${content.slice(0, MAX_FILE_BYTES)}\n[... truncated ...]` : content;
    },

    async readMany(paths): Promise<Map<string, string>> {
      const out = new Map<string, string>();
      for (const path of paths) {
        try {
          out.set(path, await this.read(path));
        } catch {
          // A path from the inventory can vanish between walk and read; skipping
          // is correct, and failing the whole analysis for one file is not.
        }
      }
      return out;
    },

    dispose: async (): Promise<void> => {
      await input.cleanup?.();
    },
  };
}

/** Normalise the many ways people name a GitHub repository. */
export function parseRepoSpec(spec: string): { slug: string; url: string } {
  const trimmed = spec.trim().replace(/\.git$/u, '').replace(/\/$/u, '');

  const httpsMatch = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)/u.exec(trimmed);
  if (httpsMatch?.[1] !== undefined && httpsMatch[2] !== undefined) {
    const slug = `${httpsMatch[1]}/${httpsMatch[2]}`;
    return { slug, url: `https://github.com/${slug}.git` };
  }

  const sshMatch = /^git@github\.com:([^/]+)\/(.+)$/u.exec(trimmed);
  if (sshMatch?.[1] !== undefined && sshMatch[2] !== undefined) {
    const slug = `${sshMatch[1]}/${sshMatch[2]}`;
    return { slug, url: `git@github.com:${slug}.git` };
  }

  const shorthand = /^([\w.-]+)\/([\w.-]+)$/u.exec(trimmed);
  if (shorthand?.[1] !== undefined && shorthand[2] !== undefined) {
    const slug = `${shorthand[1]}/${shorthand[2]}`;
    return { slug, url: `https://github.com/${slug}.git` };
  }

  throw new LocalMindError('CONFIG_INVALID', `Cannot parse "${spec}" as a GitHub repository.`, {
    remedy: 'Use `owner/name`, a https://github.com/... URL, or git@github.com:owner/name.git.',
  });
}

export interface OpenRepositoryOptions {
  /** `owner/name`, a GitHub URL, or an SSH remote. Mutually exclusive with `path`. */
  readonly repo?: string;
  /** An already-local checkout. Nothing is cloned and nothing is deleted. */
  readonly path?: string;
  readonly ref?: string;
  /** Injected into the clone URL for private repos. Never logged or persisted. */
  readonly token?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (message: string) => void;
}

export async function openRepository(options: OpenRepositoryOptions): Promise<Repository> {
  // ── Local path: no clone, no cleanup ─────────────────────────────────────
  if (options.path !== undefined) {
    const root = options.path;
    const info = await inspectPath(root);
    if (!info.isDirectory) {
      throw new LocalMindError('CORPUS_UNREADABLE', `"${root}" is not a readable directory.`, {
        remedy: 'Point `path` at a checked-out repository.',
        details: { exists: info.exists },
      });
    }

    options.onProgress?.(`reading local repository at ${root}`);
    const { files, truncated } = await inventory(root);

    let ref = options.ref ?? 'local';
    try {
      ref = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root, 10_000);
    } catch {
      // Not a git checkout, or git is unavailable. A plain directory is fine.
    }

    const slug = root.split(/[\\/]/u).filter(Boolean).pop() ?? 'local';
    log.info('local repository opened', { root, files: files.length, truncated });
    return makeRepository({ slug, ref, root, files, truncated });
  }

  // ── Remote: shallow clone into a temp directory ──────────────────────────
  if (options.repo === undefined) {
    throw new LocalMindError('CONFIG_INVALID', 'Provide either `repo` or `path`.', {
      remedy: 'githubSource({ repo: "owner/name" }) or githubSource({ path: "../checkout" })',
    });
  }

  const { slug, url } = parseRepoSpec(options.repo);
  const cloneUrl =
    options.token !== undefined && url.startsWith('https://')
      ? url.replace('https://', `https://x-access-token:${options.token}@`)
      : url;

  const root = await mkdtemp(join(tmpdir(), 'localmind-repo-'));
  const cleanup = async (): Promise<void> => {
    await removeDirectory(root);
  };

  try {
    options.onProgress?.(`cloning ${slug}${options.ref !== undefined ? `@${options.ref}` : ''}`);

    // A plain shallow clone. A blobless `--filter=blob:none --sparse` clone is
    // faster on very large repositories, but it needs a follow-up
    // `sparse-checkout` call whose correct invocation differs between cone and
    // non-cone mode - and getting that wrong fails the clone outright. The file
    // filter in `inventory()` already discards most of what a big repo contains,
    // so the marginal transfer saving is not worth the extra failure mode.
    const args = ['clone', '--depth', '1', '--single-branch', '--no-tags'];
    if (options.ref !== undefined) args.push('--branch', options.ref);
    args.push(cloneUrl, root);

    await runGit(args);

    const resolvedRef = options.ref ?? (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root, 10_000));

    options.onProgress?.('indexing files');
    const { files, truncated } = await inventory(root);

    log.info('repository cloned', { slug, ref: resolvedRef, files: files.length, truncated });
    return makeRepository({ slug, ref: resolvedRef, root, files, truncated, cleanup });
  } catch (error) {
    await cleanup();
    const message = describeUnknownError(error);

    // Credential and not-found failures look identical from git for private
    // repos, so the remedy has to cover both.
    const looksPrivate = /Authentication|not found|could not read Username|Permission denied/iu.test(message);

    throw new LocalMindError('CORPUS_UNREADABLE', `Could not clone ${slug}: ${message}`, {
      remedy: looksPrivate
        ? 'If the repository is private, pass a token with repo scope, or make sure your git credential helper / SSH agent can reach it.'
        : 'Check the repository name and branch, and that `git` is on PATH.',
      details: { slug, ref: options.ref ?? null },
      cause: error,
    });
  }
}
