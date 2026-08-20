import { createLogger } from '../../core/logger';
import { LocalMindError, describeUnknownError } from '../../core/errors';
import type { DataSource, SourceCollectResult, SourceContext } from '../types';

import { buildDeterministicDocuments, buildSynthesisedDocuments } from './analyze';
import { detectServices } from './detect';
import { openRepository, parseRepoSpec } from './repository';

/**
 * The GitHub data source.
 *
 * Pipeline: clone (or open a local path) → index files → read manifests →
 * detect services → build deterministic documents → synthesise architecture
 * documents → dispose of the clone.
 *
 * The disposal is in a `finally`: a temp directory holding a cloned repository
 * must not survive a failure, and on Windows a leaked clone with a locked
 * `.git` is genuinely annoying to remove by hand.
 */

const log = createLogger('sources:github');

/** Files always read in full, because detection and doc generation need them. */
const ALWAYS_READ = /(^|\/)(package\.json|tsconfig\.json|requirements\.txt|pyproject\.toml|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|Gemfile|composer\.json|mix\.exs|Dockerfile|docker-compose\.ya?ml|compose\.ya?ml|serverless\.ya?ml|template\.yaml|vercel\.json|netlify\.toml|fly\.toml|schema\.prisma|drizzle\.config\.ts|knexfile\.js|openapi\.(ya?ml|json)|swagger\.(ya?ml|json)|README\.mdx?|ARCHITECTURE\.mdx?|CONTRIBUTING\.mdx?|DEPLOYMENT\.mdx?|DESIGN\.mdx?|\.env\.(example|sample|template|defaults))$/iu;

/** Extra files scanned only for `process.env` style references. */
const ENV_SCAN_LIMIT = 120;

export interface GithubSourceOptions {
  /** `owner/name`, a GitHub URL, or an SSH remote. */
  readonly repo?: string;
  /** An already-local checkout. Nothing is cloned or deleted. */
  readonly path?: string;
  readonly ref?: string;
  /** Token for private repositories. Used for the clone URL only; never stored. */
  readonly token?: string;
  /**
   * Skip the model-written architecture documents. The deterministic documents
   * (structure, dependencies, configuration, services, README) are still built,
   * so the repository remains fully searchable at zero model cost.
   */
  readonly skipSynthesis?: boolean;
}

export function githubSource(options: GithubSourceOptions): DataSource {
  const label =
    options.repo !== undefined ? parseRepoSpec(options.repo).slug : (options.path ?? 'local repository');
  const ref = `github:${label}@${options.ref ?? 'default'}`;

  return {
    kind: 'github',
    ref,
    label,

    async collect(context: SourceContext): Promise<SourceCollectResult> {
      const progress = (stage: string, detail?: string): void => {
        context.onProgress?.({ stage, ...(detail !== undefined ? { detail } : {}) });
      };

      progress('clone', label);

      const repository = await openRepository({
        ...(options.repo !== undefined ? { repo: options.repo } : {}),
        ...(options.path !== undefined ? { path: options.path } : {}),
        ...(options.ref !== undefined ? { ref: options.ref } : {}),
        ...(options.token !== undefined ? { token: options.token } : {}),
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
        onProgress: (message) => progress('clone', message),
      });

      try {
        const sourceRef = `github:${repository.slug}@${repository.ref}`;
        const warnings: string[] = [];

        if (repository.files.length === 0) {
          throw new LocalMindError('CORPUS_EMPTY', `No readable source files found in ${repository.slug}.`, {
            remedy: 'The repository may contain only binaries or excluded paths. Check the ref is correct.',
          });
        }

        // ── Read the files detection and documentation need ────────────────
        progress('read', `${repository.files.length} indexed files`);

        const manifestPaths = repository.files
          .filter((file) => ALWAYS_READ.test(file.path))
          .map((file) => file.path);

        // Sample source files for env-var references. Shallow files first: config
        // and wiring live near the root, and that is where env reads cluster.
        const envScanPaths = repository.files
          .filter((file) => !ALWAYS_READ.test(file.path) && /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|php|cs)$/u.test(file.path))
          .sort((a, b) => a.depth - b.depth || b.bytes - a.bytes)
          .slice(0, ENV_SCAN_LIMIT)
          .map((file) => file.path);

        const contents = await repository.readMany([...manifestPaths, ...envScanPaths]);

        if (repository.truncated) {
          warnings.push('The repository is large; the file inventory was truncated and analysis is based on a sample.');
        }

        // ── Detect ─────────────────────────────────────────────────────────
        progress('detect', 'services, dependencies, configuration');
        const detection = detectServices({ repository, contents });

        // ── Deterministic documents ────────────────────────────────────────
        progress('document', 'structure, dependencies, configuration, services');
        const deterministic = buildDeterministicDocuments({
          repository,
          sourceRef,
          dependencies: detection.dependencies,
          envVars: detection.envVars,
          services: detection.services,
          contents,
        });

        // ── Synthesised documents ──────────────────────────────────────────
        let synthesised: Awaited<ReturnType<typeof buildSynthesisedDocuments>> = { documents: [], warnings: [] };

        if (options.skipSynthesis === true) {
          warnings.push('Architecture synthesis was skipped by request.');
        } else if (context.chatModel === undefined) {
          warnings.push('No chat model was supplied, so the architecture documents were not generated.');
        } else {
          progress('synthesise', 'reading key files and writing architecture docs');
          synthesised = await buildSynthesisedDocuments({
            repository,
            sourceRef,
            chatModel: context.chatModel,
            ...(context.signal !== undefined ? { signal: context.signal } : {}),
          });
        }

        const documents = [...deterministic, ...synthesised.documents];

        log.info('repository collected', {
          slug: repository.slug,
          documents: documents.length,
          services: detection.services.length,
        });

        return {
          documents,
          warnings: [...warnings, ...synthesised.warnings],
          detectedServices: detection.services,
          stats: {
            repository: repository.slug,
            ref: repository.ref,
            indexedFiles: repository.files.length,
            dependencies: detection.dependencies.length,
            envVars: detection.envVars.length,
            deterministicDocuments: deterministic.length,
            synthesisedDocuments: synthesised.documents.length,
          },
        };
      } catch (error) {
        if (LocalMindError.is(error)) throw error;
        throw new LocalMindError('CORPUS_UNREADABLE', `Analysing ${label} failed: ${describeUnknownError(error)}`, {
          remedy: 'Re-run with LOCALMIND_LOG_LEVEL=debug for the failing step.',
          cause: error,
        });
      } finally {
        // Always remove a temp clone, including on failure.
        await repository.dispose();
      }
    },
  };
}

export { parseRepoSpec } from './repository';
export type { Repository, RepoFile } from './repository';
export { detectServices } from './detect';
