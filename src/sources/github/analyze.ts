import { z } from 'zod';

import { createLogger } from '../../core/logger';
import { safeGenerateObject } from '../../core/resilience';
import { estimateTokens, truncateToTokens } from '../../core/tokens';
import type { CorpusDocumentInput } from '../../corpus/corpus-service';
import type { DetectedService } from '../types';

import type { Repository, RepoFile } from './repository';

/**
 * Turning a repository into a knowledge base.
 *
 * THE CENTRAL DESIGN DECISION: TWO CLASSES OF DOCUMENT
 *
 * Deterministic documents are transcriptions - the dependency inventory, the
 * directory map, the env var list, the README. They are free, exact, and cannot
 * hallucinate. Most of the practical value is here, and it is the part people
 * skip because it is unglamorous.
 *
 * Synthesised documents are summaries - "what is this repo, how does a request
 * flow through it, what are the module boundaries". These need a model, and are
 * therefore the only part that can be wrong. So they are clearly labelled as
 * synthesised in their own text, and every one of them degrades to *absent*
 * rather than to *wrong*: if the model call fails, the deterministic documents
 * still ship and the repo is still searchable.
 *
 * THE BUDGET PROBLEM
 * A model cannot read a repository. It can read a few hundred KB. So file
 * selection is the whole game: manifests first (they describe intent), then
 * entrypoints, then the largest files in the densest source directories. That
 * ordering finds the architecture far more reliably than sampling uniformly.
 */

const log = createLogger('sources:github:analyze');

/** Budget for the file digest handed to the model, per synthesis call. */
const DIGEST_TOKEN_BUDGET = 12_000;
/** Per-file share of that budget, so one large file cannot dominate. */
const PER_FILE_TOKEN_BUDGET = 900;

const ENTRYPOINT_PATTERNS: readonly RegExp[] = [
  /^(src\/)?(index|main|app|server|cli|worker|entry)\.[jt]sx?$/u,
  /^(src\/)?main\.(py|go|rs|java|rb)$/u,
  /^cmd\/[^/]+\/main\.go$/u,
  /^app\/(layout|page)\.[jt]sx$/u,
  /^(src\/)?routes?\//u,
  /^(src\/)?api\//u,
  /^(src\/)?handlers?\//u,
  /^lambda\//u,
  /^functions\//u,
];

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin',
  '.rb': 'Ruby', '.php': 'PHP', '.cs': 'C#', '.swift': 'Swift', '.scala': 'Scala',
  '.c': 'C', '.h': 'C', '.cc': 'C++', '.cpp': 'C++', '.hpp': 'C++',
  '.ex': 'Elixir', '.exs': 'Elixir', '.dart': 'Dart', '.lua': 'Lua',
  '.sh': 'Shell', '.bash': 'Shell', '.sql': 'SQL', '.tf': 'Terraform',
  '.graphql': 'GraphQL', '.gql': 'GraphQL', '.proto': 'Protobuf',
};

export interface DirectoryStat {
  readonly path: string;
  readonly files: number;
  readonly bytes: number;
  readonly languages: readonly string[];
}

/** Group files by their top two path segments — the level at which modules live. */
export function summariseDirectories(files: readonly RepoFile[]): DirectoryStat[] {
  const groups = new Map<string, { files: number; bytes: number; languages: Set<string> }>();

  for (const file of files) {
    const segments = file.path.split('/');
    const key = segments.length === 1 ? '(root)' : segments.slice(0, Math.min(2, segments.length - 1)).join('/');
    const entry = groups.get(key) ?? { files: 0, bytes: 0, languages: new Set<string>() };
    entry.files += 1;
    entry.bytes += file.bytes;
    const language = LANGUAGE_BY_EXTENSION[file.extension];
    if (language !== undefined) entry.languages.add(language);
    groups.set(key, entry);
  }

  return [...groups.entries()]
    .map(([path, entry]) => ({
      path,
      files: entry.files,
      bytes: entry.bytes,
      languages: [...entry.languages].sort(),
    }))
    .sort((a, b) => b.files - a.files);
}

export function languageBreakdown(files: readonly RepoFile[]): { language: string; files: number; bytes: number }[] {
  const totals = new Map<string, { files: number; bytes: number }>();
  for (const file of files) {
    const language = LANGUAGE_BY_EXTENSION[file.extension];
    if (language === undefined) continue;
    const entry = totals.get(language) ?? { files: 0, bytes: 0 };
    entry.files += 1;
    entry.bytes += file.bytes;
    totals.set(language, entry);
  }
  return [...totals.entries()]
    .map(([language, entry]) => ({ language, ...entry }))
    .sort((a, b) => b.bytes - a.bytes);
}

/**
 * Choose which files the model gets to read.
 *
 * Priority order is the important part: manifests describe intent, entrypoints
 * describe flow, and the biggest files in the densest directories describe
 * structure. Alphabetical or uniform sampling reliably finds none of those.
 */
export function selectFilesForSynthesis(files: readonly RepoFile[], limit = 40): RepoFile[] {
  const score = (file: RepoFile): number => {
    let value = 0;
    if (file.isManifest) value += 1000;
    if (ENTRYPOINT_PATTERNS.some((pattern) => pattern.test(file.path))) value += 500;
    if (/readme|architecture|design|contributing/iu.test(file.path)) value += 400;
    if (/\.(sql|prisma|graphql|proto|tf)$/u.test(file.path)) value += 300;
    // Shallow files are more likely to be structural; deep ones are leaves.
    value += Math.max(0, 100 - file.depth * 20);
    // Prefer substantial files, but with diminishing returns.
    value += Math.min(80, Math.log2(Math.max(1, file.bytes)) * 6);
    if (/\.(test|spec)\./u.test(file.path) || /(^|\/)(tests?|__tests__)\//u.test(file.path)) value -= 300;
    if (/\.d\.ts$/u.test(file.path)) value -= 200;
    return value;
  };

  return [...files].sort((a, b) => score(b) - score(a)).slice(0, limit);
}

/** Build the bounded text digest handed to the model. */
async function buildDigest(repository: Repository, files: readonly RepoFile[]): Promise<string> {
  const contents = await repository.readMany(files.map((file) => file.path));
  const parts: string[] = [];
  let spent = 0;

  for (const file of files) {
    const raw = contents.get(file.path);
    if (raw === undefined) continue;

    const allowance = Math.min(PER_FILE_TOKEN_BUDGET, DIGEST_TOKEN_BUDGET - spent);
    if (allowance <= 60) break;

    const { text } = truncateToTokens(raw, allowance);
    spent += estimateTokens(text);
    parts.push(`### ${file.path}\n\`\`\`\n${text}\n\`\`\``);
  }

  log.debug('digest built', { files: parts.length, tokens: spent });
  return parts.join('\n\n');
}

/* ────────────────────────────────────────────────────────────────────────────
 * Deterministic documents
 * ──────────────────────────────────────────────────────────────────────────── */

export interface DeterministicInput {
  readonly repository: Repository;
  readonly sourceRef: string;
  readonly dependencies: readonly string[];
  readonly envVars: readonly string[];
  readonly services: readonly DetectedService[];
  readonly contents: Map<string, string>;
}

export function buildDeterministicDocuments(input: DeterministicInput): CorpusDocumentInput[] {
  const { repository, sourceRef } = input;
  const slug = repository.slug;
  const documents: CorpusDocumentInput[] = [];
  const directories = summariseDirectories(repository.files);
  const languages = languageBreakdown(repository.files);
  const totalBytes = repository.files.reduce((sum, file) => sum + file.bytes, 0);

  const base = { origin: 'github' as const, sourceRef, tags: ['github', slug] };

  // ── Structure ────────────────────────────────────────────────────────────
  documents.push({
    ...base,
    id: `gh-${slugId(slug)}-structure`,
    title: `${slug} — repository structure`,
    sourcePath: `https://github.com/${slug}`,
    text: [
      `# ${slug} — repository structure`,
      '',
      `Branch/ref: \`${repository.ref}\`. ${repository.files.length} indexed files, ${formatBytes(totalBytes)} of source.`,
      repository.truncated ? '\n> The file inventory was truncated; very large repositories are sampled.' : '',
      '',
      '## Languages',
      '',
      '| Language | Files | Size |',
      '| --- | --- | --- |',
      ...languages.slice(0, 12).map((entry) => `| ${entry.language} | ${entry.files} | ${formatBytes(entry.bytes)} |`),
      '',
      '## Directories',
      '',
      '| Path | Files | Size | Languages |',
      '| --- | --- | --- | --- |',
      ...directories
        .slice(0, 30)
        .map((entry) => `| \`${entry.path}\` | ${entry.files} | ${formatBytes(entry.bytes)} | ${entry.languages.join(', ') || '—'} |`),
      '',
      '## Notable files',
      '',
      ...repository.files
        .filter((file) => file.isManifest)
        .slice(0, 40)
        .map((file) => `- \`${file.path}\``),
    ]
      .filter((line) => line !== '')
      .join('\n'),
  });

  // ── Dependencies ─────────────────────────────────────────────────────────
  if (input.dependencies.length > 0) {
    documents.push({
      ...base,
      id: `gh-${slugId(slug)}-dependencies`,
      title: `${slug} — dependencies`,
      sourcePath: `https://github.com/${slug}`,
      text: [
        `# ${slug} — dependencies`,
        '',
        `${input.dependencies.length} distinct declared dependencies across all package manifests.`,
        '',
        '## All dependencies',
        '',
        input.dependencies.map((name) => `- \`${name}\``).join('\n'),
      ].join('\n'),
    });
  }

  // ── Configuration surface ────────────────────────────────────────────────
  if (input.envVars.length > 0) {
    documents.push({
      ...base,
      id: `gh-${slugId(slug)}-configuration`,
      title: `${slug} — configuration and environment variables`,
      sourcePath: `https://github.com/${slug}`,
      text: [
        `# ${slug} — configuration and environment variables`,
        '',
        `${input.envVars.length} environment variables are referenced in code or declared in \`.env\` samples.`,
        'This is the configuration surface of the system: every external dependency,',
        'credential and feature flag has to appear here somewhere.',
        '',
        '## Referenced variables',
        '',
        input.envVars.map((name) => `- \`${name}\``).join('\n'),
      ].join('\n'),
    });
  }

  // ── Detected services ────────────────────────────────────────────────────
  if (input.services.length > 0) {
    documents.push({
      ...base,
      id: `gh-${slugId(slug)}-services`,
      title: `${slug} — external services and data stores`,
      sourcePath: `https://github.com/${slug}`,
      text: [
        `# ${slug} — external services and data stores`,
        '',
        'Detected by static analysis of dependencies, container definitions,',
        'infrastructure-as-code and environment samples.',
        '',
        ...input.services.flatMap((service) => [
          `## ${service.label} (\`${service.kind}\`)`,
          '',
          `Confidence: **${service.confidence}**. ${service.connectorAvailable ? 'A live LocalMind connector is available for this service.' : 'No live connector; document it manually if you need its schema.'}`,
          '',
          'Evidence:',
          ...service.evidence.map((line) => `- ${line}`),
          service.envVars.length > 0 ? `\nRelevant environment variables: ${service.envVars.map((name) => `\`${name}\``).join(', ')}` : '',
          '',
        ]),
      ]
        .filter((line) => line !== '')
        .join('\n'),
    });
  }

  // ── Verbatim project docs ────────────────────────────────────────────────
  for (const [path, raw] of input.contents) {
    if (!/(^|\/)(README|ARCHITECTURE|CONTRIBUTING|DEPLOYMENT|DESIGN)\.mdx?$/iu.test(path)) continue;
    // Title by full path, not basename: a monorepo has a dozen README.md files
    // and "hono — README.md" repeated twelve times is unusable in a document
    // list. The path is what distinguishes them.
    documents.push({
      ...base,
      id: `gh-${slugId(slug)}-doc-${slugId(path)}`,
      title: `${slug} — ${path}`,
      sourcePath: `https://github.com/${slug}/blob/${repository.ref}/${path}`,
      tags: [...base.tags, 'project-doc'],
      // Verbatim: this is the maintainers' own description, and paraphrasing
      // the authoritative text in favour of a model summary is a downgrade.
      text: raw,
    });
  }

  return documents;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Synthesised documents
 * ──────────────────────────────────────────────────────────────────────────── */

const OverviewSchema = z.object({
  purpose: z.string().describe('What this project does, in 2-4 sentences, concrete and specific.'),
  stack: z.array(z.string()).describe('Languages, frameworks and major libraries actually used.'),
  entrypoints: z
    .array(z.object({ path: z.string(), role: z.string() }))
    .describe('Files where execution begins: servers, CLIs, lambda handlers, page routes.'),
  modules: z
    .array(z.object({ path: z.string(), responsibility: z.string() }))
    .describe('Top-level directories and what each is responsible for.'),
  dataFlow: z
    .string()
    .describe('How a typical request or job flows through the system, naming real modules in order.'),
  mermaid: z
    .string()
    .describe('A mermaid `flowchart TD` diagram of the main components and their data flow. Node labels must be real module or service names. No markdown fences.'),
  conventions: z.array(z.string()).describe('Notable patterns a new contributor must know.'),
  risks: z.array(z.string()).describe('Coupling, missing tests, or operational hazards visible from the code.'),
});

export const ANALYZE_INSTRUCTIONS = `You are a staff engineer writing onboarding documentation for a codebase you have just read.

You are given a digest of the most architecturally significant files from a
repository: manifests, entrypoints, configuration and the largest source files.

Rules:
- Be specific. Name real files, real directories, real functions. "The service
  layer handles business logic" is worthless; "src/billing/charge.ts converts a
  Stripe webhook into a Ledger entry" is useful.
- Only state what the digest supports. If you cannot tell how something works,
  omit it. Do not infer a database, a queue or a framework that is not visible.
- The mermaid diagram must use real names from the repository and must be valid
  \`flowchart TD\` syntax. Do not wrap it in a code fence.
- Prefer the vocabulary the repository itself uses, so that later searches with
  that vocabulary will match.`;

export interface SynthesisInput {
  readonly repository: Repository;
  readonly sourceRef: string;
  readonly chatModel: NonNullable<Parameters<typeof safeGenerateObject>[0]['model']>;
  readonly signal?: AbortSignal;
}

export interface SynthesisOutput {
  readonly documents: readonly CorpusDocumentInput[];
  readonly warnings: readonly string[];
}

export async function buildSynthesisedDocuments(input: SynthesisInput): Promise<SynthesisOutput> {
  const { repository, sourceRef } = input;
  const slug = repository.slug;
  const selected = selectFilesForSynthesis(repository.files);
  const digest = await buildDigest(repository, selected);

  if (digest.trim().length === 0) {
    return { documents: [], warnings: ['No readable source files were found to analyse.'] };
  }

  const result = await safeGenerateObject({
    model: input.chatModel,
    schema: OverviewSchema,
    instructions: ANALYZE_INSTRUCTIONS,
    prompt: [
      `REPOSITORY: ${slug} (ref ${repository.ref})`,
      `INDEXED FILES: ${repository.files.length}`,
      '',
      'DIGEST:',
      digest,
    ].join('\n'),
    label: 'github-analyze',
    attempts: 2,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  if (!result.ok) {
    // Degrade to absent, never to wrong.
    log.warn('repository synthesis failed', { slug, error: result.error });
    return {
      documents: [],
      warnings: [
        `Architecture synthesis failed (${result.error}). The repository is still fully searchable via its structure, dependency and configuration documents.`,
      ],
    };
  }

  const overview = result.value;
  const base = { origin: 'github' as const, sourceRef, tags: ['github', slug, 'synthesised'] };
  const provenance =
    '\n\n---\n*Synthesised by LocalMind from a digest of this repository. Verify against the source before relying on it.*';

  const documents: CorpusDocumentInput[] = [
    {
      ...base,
      id: `gh-${slugId(slug)}-overview`,
      title: `${slug} — what this project does`,
      sourcePath: `https://github.com/${slug}`,
      text: [
        `# ${slug} — what this project does`,
        '',
        overview.purpose,
        '',
        '## Stack',
        '',
        overview.stack.map((entry) => `- ${entry}`).join('\n'),
        '',
        '## Entrypoints',
        '',
        overview.entrypoints.map((entry) => `- \`${entry.path}\` — ${entry.role}`).join('\n'),
        '',
        '## Conventions',
        '',
        overview.conventions.map((entry) => `- ${entry}`).join('\n'),
        provenance,
      ].join('\n'),
    },
    {
      ...base,
      id: `gh-${slugId(slug)}-architecture`,
      title: `${slug} — architecture and data flow`,
      sourcePath: `https://github.com/${slug}`,
      text: [
        `# ${slug} — architecture and data flow`,
        '',
        '## Module responsibilities',
        '',
        overview.modules.map((entry) => `- \`${entry.path}\` — ${entry.responsibility}`).join('\n'),
        '',
        '## How a request flows',
        '',
        overview.dataFlow,
        '',
        '## Component diagram',
        '',
        '```mermaid',
        overview.mermaid.replace(/^```(?:mermaid)?\n?|\n?```$/gu, '').trim(),
        '```',
        '',
        '## Risks and rough edges',
        '',
        overview.risks.map((entry) => `- ${entry}`).join('\n'),
        provenance,
      ].join('\n'),
    },
  ];

  log.info('repository synthesised', { slug, documents: documents.length });
  return { documents, warnings: [] };
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function slugId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 60);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
