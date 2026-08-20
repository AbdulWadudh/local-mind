import type { EmbeddingModel, LanguageModel } from 'ai';

import { loadConfig } from './core/config';
import type { LocalMindConfig } from './core/config';
import { LocalMindError } from './core/errors';
import { createLogger } from './core/logger';
import { createModelRegistry } from './core/providers';
import { createModelRecorder } from './core/recorder';
import type { ModelCallStage, ModelRecorder } from './core/recorder';
import type { ModelRegistry } from './core/providers';
import type { RetrievedChunk, Retriever } from './core/types';

import { openCorpusService } from './corpus/corpus-service';
import type { CorpusDocumentInput, CorpusService, CorpusWriteResult } from './corpus/corpus-service';
import type { DocumentOrigin } from './store/document-store';
import { openRetriever } from './retrieval/retriever';
import { generateGroundedAnswer, streamGroundedAnswer } from './generation/grounded-answer';
import { GROUNDED_ANSWER_INSTRUCTIONS, QUERY_REWRITE_INSTRUCTIONS } from './generation/prompt';
import type { GroundedAnswerResult, StreamedGroundedAnswer } from './generation/grounded-answer';
import { AGENT_INSTRUCTIONS, runRetrievalAgent } from './agent/retrieval-agent';
import type { AgentRunResult } from './agent/retrieval-agent';
import { DEFAULT_BUDGET, runSelfCorrectingWorkflow } from './workflow/graph';
import { GRADE_INSTRUCTIONS } from './workflow/nodes/grade';
import { PLAN_INSTRUCTIONS } from './workflow/nodes/plan';
import { VERIFY_INSTRUCTIONS } from './workflow/nodes/verify';
import { ANALYZE_INSTRUCTIONS } from './sources/github/analyze';
import type { WorkflowBudget, WorkflowEvent, WorkflowResult } from './workflow/graph';
import { createWebSearchProvider } from './workflow/web-search';
import type { WebSearchProvider } from './workflow/web-search';
import type { DataSource, DetectedService, SourceProgress } from './sources/types';

/**
 * The public facade.
 *
 * Four stages, five subsystems and nine connectors is a lot of surface for a
 * consumer to learn. This class is the 90% path: open it, feed it, ask it
 * things. Everything underneath stays exported for the 10% who need to compose
 * differently — the facade adds no capability, it only removes wiring.
 *
 * ONE NON-OBVIOUS THING IT HANDLES FOR YOU
 * LanceDB tables are versioned, and a `Table` handle opened before a write does
 * not necessarily observe that write. In a long-lived process — which is exactly
 * what the Studio is — that shows up as "I added a document and the very next
 * question could not find it". So the retriever is cached but *generation-
 * tagged*: any corpus mutation bumps the generation and the next query reopens.
 * Getting this wrong is invisible in a CLI and maddening in a server.
 */

const log = createLogger('localmind');

export interface LocalMindOpenOptions {
  /**
   * A complete config, or a partial overlay on top of the environment. Partial
   * overlays are shallow-merged per section, which is what makes per-tenant
   * table names a one-liner.
   */
  readonly config?: LocalMindConfig | DeepPartialConfig;
  /** Env source for `loadConfig`. Defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>;
  /** Override the resolved models, e.g. for tests. */
  readonly models?: { readonly chat?: LanguageModel; readonly grader?: LanguageModel; readonly embedding?: EmbeddingModel };
  readonly webSearch?: WebSearchProvider;
  /**
   * Prompt/response recording. On by default with a 200-call ring buffer —
   * bounded, in-memory, and never written to disk. Pass `{ enabled: false }` to
   * turn it off entirely; the wrapper then returns the model untouched, so there
   * is no middleware in the call path at all.
   */
  readonly recorder?: RecorderOptions;
}

type DeepPartialConfig = {
  readonly [K in keyof LocalMindConfig]?: Partial<LocalMindConfig[K]>;
};

function isCompleteConfig(value: LocalMindConfig | DeepPartialConfig): value is LocalMindConfig {
  const candidate = value as Partial<LocalMindConfig>;
  return (
    candidate.chat !== undefined &&
    candidate.embedding !== undefined &&
    candidate.store !== undefined &&
    candidate.chunking !== undefined &&
    candidate.retrieval !== undefined
  );
}

function mergeConfig(base: LocalMindConfig, overlay: DeepPartialConfig): LocalMindConfig {
  return {
    chat: { ...base.chat, ...overlay.chat },
    embedding: { ...base.embedding, ...overlay.embedding },
    ollama: { ...base.ollama, ...overlay.ollama },
    openrouter: { ...base.openrouter, ...overlay.openrouter },
    store: { ...base.store, ...overlay.store },
    chunking: { ...base.chunking, ...overlay.chunking },
    retrieval: { ...base.retrieval, ...overlay.retrieval },
    agent: { ...base.agent, ...overlay.agent },
    webSearch: { ...base.webSearch, ...overlay.webSearch },
  };
}

export interface IngestSourceResult {
  readonly sourceRef: string
  readonly kind: string;
  readonly label: string;
  readonly documentsWritten: number;
  readonly documentsReplaced: number;
  readonly chunksWritten: number;
  readonly warnings: readonly string[];
  readonly detectedServices: readonly DetectedService[];
  readonly stats: Readonly<Record<string, number | string>>;
  readonly durationMs: number;
}

/** Recorder tuning, forwarded to `createModelRecorder`. */
export interface RecorderOptions {
  readonly capacity?: number;
  readonly maxBytes?: number;
  readonly enabled?: boolean;
}

export interface AskOptions {
  readonly topK?: number;
  readonly minScore?: number;
  readonly maxContextTokens?: number;
  readonly signal?: AbortSignal;
  /**
   * Restrict retrieval to the documents produced by one ingested source, e.g.
   * `github:vercel/ai@main` or `postgres:db.internal/app`. Omit for the whole
   * corpus, and use `MANUAL_SCOPE` for documents that belong to no source run.
   *
   * Resolved to a `documentId IN (...)` predicate rather than a column filter,
   * because chunks do not carry `sourceRef` — that lives on the document row.
   * Resolving it here keeps the chunk schema stable, which matters: adding a
   * column would invalidate every index already written to disk.
   */
  readonly sourceRef?: string;
}

/** `sourceRef` value that selects documents belonging to no source run. */
export const MANUAL_SCOPE = '@standalone';

/**
 * Upper bound on a scope resolution or a project listing.
 *
 * A corpus larger than this is possible, and the consequence is a scope that
 * silently covers only the first 20k documents. That is why it is a named
 * constant with a comment rather than an inline `100000`: if it is ever hit,
 * the fix is a `sourceRef` column on the chunk table, not a bigger number.
 */
const SCOPE_ID_LIMIT = 20_000;

/** A distinct ingested source, with what it contributed to the corpus. */
export interface ProjectSummary {
  readonly sourceRef: string;
  readonly label: string;
  readonly origin: DocumentOrigin;
  readonly documents: number;
  readonly chunks: number;
  readonly updatedAt: string;
}

export interface AgentOptions extends AskOptions {
  readonly maxSteps?: number;
  readonly onStep?: (info: { step: number; toolCalls: readonly string[]; text: string }) => void;
}

export interface ResearchOptions extends AskOptions {
  readonly budget?: WorkflowBudget;
  readonly onEvent?: (event: WorkflowEvent) => void;
}

/** Escape a string literal for a LanceDB SQL predicate. */
function sqlLiteral(value: string): string {
  return "'" + value.replace(/'/gu, "''") + "'";
}

/**
 * A source ref rendered for a human: `github:vercel/ai@main` -> `vercel/ai@main`.
 *
 * The kind prefix is already carried by the origin badge next to it, so
 * repeating it in the label just costs width in a dropdown.
 */
function describeSourceRef(ref: string): string {
  const separator = ref.indexOf(':');
  return separator === -1 ? ref : ref.slice(separator + 1);
}

/**
 * Wrap a retriever so every search it performs carries an extra predicate.
 *
 * This is why scoping needed no changes to the agent or the workflow. Both take
 * a `Retriever` and call `.search()`; handing them a wrapped one confines the
 * filter to one place instead of threading a `where` string through four call
 * sites, two tool definitions and a graph node.
 *
 * `close()` is intentionally a no-op: the wrapper does not own the underlying
 * retriever, and closing a shared handle out from under the next request is the
 * kind of bug that only appears under concurrency.
 */
function scopeRetriever(base: Retriever, where: string): Retriever {
  return {
    search: (query, options = {}) =>
      base.search(query, {
        ...options,
        where: options.where === undefined ? where : `(${options.where}) AND (${where})`,
      }),
    listSources: () => base.listSources(),
    close: () => Promise.resolve(),
  };
}

/**
 * Map a system prompt back to the pipeline stage that issued it.
 *
 * Built from the actual exported constants rather than from copied fragments.
 * That distinction matters: a table of hand-written prefixes would drift the
 * first time someone reworded an instruction, and attribution would silently
 * degrade to `unknown` with nothing failing. Referencing the constants means a
 * reword cannot break it, because there is only one copy of the string.
 *
 * The one prompt built ad-hoc rather than from a constant is the repair pass in
 * Stage 4, which appends a directive to the grounded-answer instructions — so
 * `startsWith` rather than equality, and `ground` is the honest label for it.
 */
function classifyStage(system: string | undefined): ModelCallStage {
  if (system === undefined || system.length === 0) return 'unknown';

  const table: readonly (readonly [string, ModelCallStage])[] = [
    [GROUNDED_ANSWER_INSTRUCTIONS, 'ground'],
    [AGENT_INSTRUCTIONS, 'agent'],
    [PLAN_INSTRUCTIONS, 'plan'],
    [GRADE_INSTRUCTIONS, 'grade'],
    [QUERY_REWRITE_INSTRUCTIONS, 'rewrite'],
    [VERIFY_INSTRUCTIONS, 'verify'],
    [ANALYZE_INSTRUCTIONS, 'analyze'],
  ];

  for (const [instructions, stage] of table) {
    if (system === instructions || system.startsWith(instructions)) return stage;
  }
  return 'unknown';
}

export class LocalMind {
  readonly config: LocalMindConfig;
  readonly registry: ModelRegistry;
  readonly corpus: CorpusService;
  readonly webSearch: WebSearchProvider;
  /**
   * Every model call this instance made, prompts included.
   *
   * Session-scoped and in-memory by design. Persisting prompts is a decision a
   * consumer should make explicitly — a corpus can contain anything — so the
   * library keeps them in a bounded ring buffer and exposes them, rather than
   * writing them to disk on the user's behalf.
   */
  readonly recorder: ModelRecorder;

  #retriever: Retriever | undefined;
  #retrieverGeneration = -1;
  #generation = 0;
  #closed = false;

  private constructor(input: {
    config: LocalMindConfig;
    registry: ModelRegistry;
    corpus: CorpusService;
    webSearch: WebSearchProvider;
    recorder: ModelRecorder;
  }) {
    this.config = input.config;
    this.registry = input.registry;
    this.corpus = input.corpus;
    this.webSearch = input.webSearch;
    this.recorder = input.recorder;
  }

  static async open(options: LocalMindOpenOptions = {}): Promise<LocalMind> {
    const base = loadConfig(options.env ?? process.env);
    const config =
      options.config === undefined
        ? base
        : isCompleteConfig(options.config)
          ? options.config
          : mergeConfig(base, options.config);

    const recorder = createModelRecorder({
      classify: classifyStage,
      ...(options.recorder ?? {}),
    });

    const resolved = createModelRegistry(config);

    /*
     * The registry is wrapped ONCE, here, and every stage reads its models from
     * it. That is the whole reason the recorder cannot miss a call: a stage added
     * later is recorded because it uses the registry, not because someone
     * remembered to instrument it.
     *
     * `embedding` is left unwrapped — the middleware is for language models, and
     * a 20-chunk ingest would otherwise bury the answer prompts you actually
     * wanted to read under a hundred vector calls.
     */
    const registry: ModelRegistry = {
      chat: recorder.wrap(options.models?.chat ?? resolved.chat, 'chat'),
      grader: recorder.wrap(options.models?.grader ?? resolved.grader, 'grader'),
      embedding: options.models?.embedding ?? resolved.embedding,
      describe: resolved.describe,
    };

    const corpus = await openCorpusService({ config, embeddingModel: registry.embedding });

    const webSearch =
      options.webSearch ??
      createWebSearchProvider({
        config,
        onlineModelFactory: (slug) =>
          // Wrapped as well: an online-search call is a model call with a prompt,
          // and leaving it out would make the log quietly incomplete in exactly
          // the case where you are debugging why the web fallback answered oddly.
          recorder.wrap(createModelRegistry({ ...config, chat: { ...config.chat, model: slug } }).chat, 'chat'),
      });

    log.info('opened', { models: registry.describe(), db: config.store.dbPath });
    return new LocalMind({ config, registry, corpus, webSearch, recorder });
  }

  /* ── ingestion ────────────────────────────────────────────────────────── */

  /**
   * Run a data source and replace everything that source produced last time.
   *
   * The replace-by-`sourceRef` step is what makes re-syncing safe: without it, a
   * second run of the same GitHub repo would leave the previous run's documents
   * in place alongside the new ones, and retrieval would return two versions of
   * the same architecture doc with no way to tell which was current.
   */
  async ingestSource(
    source: DataSource,
    options: {
      readonly signal?: AbortSignal;
      readonly onProgress?: (progress: SourceProgress) => void;
      /**
       * Write only these document ids, as reported by the dry-run preview.
       * Omit to write everything the source produced.
       *
       * The filter runs *after* collection because a repository analysis is one
       * indivisible pass: it clones once and reads the tree once. Narrowing the
       * write is the useful control; narrowing the read would mean re-cloning
       * for every selection.
       */
      readonly include?: readonly string[];
    } = {},
  ): Promise<IngestSourceResult> {
    this.#assertOpen();
    const startedAt = Date.now();

    const collected = await source.collect({
      chatModel: this.registry.chat,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
    });

    // `id ?? title` mirrors exactly what the preview reported, so a selection
    // made in the UI cannot drift from what actually gets written.
    const include = options.include;
    const selected =
      include === undefined || include.length === 0
        ? collected.documents
        : collected.documents.filter((document) => include.includes(document.id ?? document.title));

    if (selected.length === 0) {
      throw new LocalMindError('CONFIG_INVALID', 'The selection matched none of the collected documents.', {
        remedy:
          'Re-run the analysis. Document ids are only valid for the preview that produced them, so a stale selection matches nothing.',
        details: { collected: collected.documents.length, requested: include?.length ?? 0 },
      });
    }

    options.onProgress?.({ stage: 'ingest', detail: `${selected.length} documents` });

    const removed = await this.corpus.removeBySourceRef(source.ref);
    const written = await this.corpus.putMany(
      selected.map((document) => ({ ...document, sourceRef: source.ref })),
    );
    this.#invalidate();

    const result: IngestSourceResult = {
      sourceRef: source.ref,
      kind: source.kind,
      label: source.label,
      documentsWritten: written.length,
      documentsReplaced: removed.documents,
      chunksWritten: written.reduce((sum, entry) => sum + entry.chunksWritten, 0),
      warnings: collected.warnings,
      detectedServices: collected.detectedServices,
      stats: collected.stats,
      durationMs: Date.now() - startedAt,
    };

    log.info('source ingested', {
      ref: source.ref,
      documents: result.documentsWritten,
      chunks: result.chunksWritten,
    });
    return result;
  }

  /** Add or replace documents directly. */
  async ingestDocuments(documents: readonly CorpusDocumentInput[]): Promise<readonly CorpusWriteResult[]> {
    this.#assertOpen();
    const written = await this.corpus.putMany(documents);
    this.#invalidate();
    return written;
  }

  async putDocument(document: CorpusDocumentInput): Promise<CorpusWriteResult> {
    this.#assertOpen();
    const written = await this.corpus.put(document);
    this.#invalidate();
    return written;
  }

  async removeDocument(id: string): Promise<{ removed: boolean; chunksRemoved: number }> {
    this.#assertOpen();
    const result = await this.corpus.remove(id);
    this.#invalidate();
    return result;
  }

  /* ── retrieval and answering ──────────────────────────────────────────── */

  /**
   * The retriever a request should use, scoped if the caller asked for one
   * source. Every answering method goes through this rather than
   * `#getRetriever()` directly, so no mode can silently ignore the scope.
   */
  async #scoped(options: AskOptions): Promise<Retriever> {
    const retriever = await this.#getRetriever();
    const ref = options.sourceRef;
    if (ref === undefined || ref.length === 0) return retriever;

    const all = await this.corpus.list(
      ref === MANUAL_SCOPE ? { limit: SCOPE_ID_LIMIT } : { sourceRef: ref, limit: SCOPE_ID_LIMIT },
    );
    const scoped = ref === MANUAL_SCOPE ? all.filter((entry) => entry.sourceRef.length === 0) : all;
    const ids = scoped.map((entry) => entry.id);

    // Fail loudly rather than silently searching everything. A scope that
    // matches nothing means the source was deleted or re-ingested under a new
    // ref, and answering from the whole corpus while the UI still shows a scope
    // chip is worse than an error: the user would trust a citation that came
    // from somewhere they explicitly excluded.
    if (ids.length === 0) {
      throw new LocalMindError('INDEX_MISSING', `No documents belong to source "${ref}".`, {
        remedy: 'Pick a different scope, or re-ingest that source from the Sources tab.',
        details: { sourceRef: ref },
      });
    }

    return scopeRetriever(retriever, `documentId IN (${ids.map(sqlLiteral).join(', ')})`);
  }

  /**
   * Every distinct source run in the corpus, most recently updated first.
   *
   * Derived from the document rows on each call rather than kept in a table of
   * its own. There is no second place for it to disagree with reality, and the
   * cost is one projection over a table whose size is measured in hundreds.
   */
  async listProjects(): Promise<readonly ProjectSummary[]> {
    this.#assertOpen();
    const documents = await this.corpus.list({ limit: SCOPE_ID_LIMIT });

    interface Group {
      origin: DocumentOrigin;
      documents: number;
      chunks: number;
      updatedAt: string;
    }
    const groups = new Map<string, Group>();

    for (const document of documents) {
      const key = document.sourceRef.length > 0 ? document.sourceRef : MANUAL_SCOPE;
      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, {
          origin: document.origin,
          documents: 1,
          chunks: document.chunkCount,
          updatedAt: document.updatedAt,
        });
        continue;
      }
      existing.documents += 1;
      existing.chunks += document.chunkCount;
      if (document.updatedAt > existing.updatedAt) existing.updatedAt = document.updatedAt;
    }

    return [...groups.entries()]
      .map(([sourceRef, group]) => ({
        sourceRef,
        label: sourceRef === MANUAL_SCOPE ? 'Standalone documents' : describeSourceRef(sourceRef),
        origin: group.origin,
        documents: group.documents,
        chunks: group.chunks,
        updatedAt: group.updatedAt,
      }))
      .sort((a, b) =>
        a.updatedAt === b.updatedAt ? b.documents - a.documents : b.updatedAt.localeCompare(a.updatedAt),
      );
  }

  /** Stage 1: retrieval only. */
  async search(query: string, options: AskOptions = {}): Promise<readonly RetrievedChunk[]> {
    const retriever = await this.#scoped(options);
    return retriever.search(query, {
      topK: options.topK ?? this.config.retrieval.topK,
      minScore: options.minScore ?? this.config.retrieval.minScore,
    });
  }

  async listSources(): Promise<readonly { title: string; relativePath: string; chunkCount: number }[]> {
    const retriever = await this.#getRetriever();
    return retriever.listSources();
  }

  /** Stage 2, streaming. */
  async ask(query: string, options: AskOptions = {}): Promise<StreamedGroundedAnswer> {
    const chunks = await this.search(query, options);
    return streamGroundedAnswer({
      model: this.registry.chat,
      question: query,
      chunks,
      maxContextTokens: options.maxContextTokens ?? this.config.retrieval.maxContextTokens,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  /** Stage 2, non-streaming. */
  async answer(query: string, options: AskOptions = {}): Promise<GroundedAnswerResult> {
    const chunks = await this.search(query, options);
    return generateGroundedAnswer({
      model: this.registry.chat,
      question: query,
      chunks,
      maxContextTokens: options.maxContextTokens ?? this.config.retrieval.maxContextTokens,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  /** Stage 3: the model drives retrieval. */
  async agent(query: string, options: AgentOptions = {}): Promise<AgentRunResult> {
    const retriever = await this.#scoped(options);
    return runRetrievalAgent({
      model: this.registry.chat,
      retriever,
      question: query,
      maxSteps: options.maxSteps ?? this.config.agent.maxSteps,
      topK: options.topK ?? this.config.retrieval.topK,
      minScore: options.minScore ?? this.config.retrieval.minScore,
      maxContextTokens: options.maxContextTokens ?? this.config.retrieval.maxContextTokens,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.onStep !== undefined ? { onStep: options.onStep } : {}),
    });
  }

  /** Stage 4: plan, grade, self-correct, verify. */
  async research(query: string, options: ResearchOptions = {}): Promise<WorkflowResult> {
    const retriever = await this.#scoped(options);
    return runSelfCorrectingWorkflow({
      chatModel: this.registry.chat,
      graderModel: this.registry.grader,
      retriever,
      webSearch: this.webSearch,
      question: query,
      topK: options.topK ?? this.config.retrieval.topK,
      minScore: options.minScore ?? this.config.retrieval.minScore,
      maxContextTokens: options.maxContextTokens ?? this.config.retrieval.maxContextTokens,
      budget: options.budget ?? DEFAULT_BUDGET,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#retriever?.close();
    this.#retriever = undefined;
    await this.corpus.close();
    log.info('closed');
  }

  /* ── internals ────────────────────────────────────────────────────────── */

  #assertOpen(): void {
    if (this.#closed) {
      throw new LocalMindError('CONFIG_INVALID', 'This LocalMind instance is closed.', {
        remedy: 'Open a new instance with `LocalMind.open()`.',
      });
    }
  }

  /** Bump the generation so the next query reopens the retriever. */
  #invalidate(): void {
    this.#generation += 1;
  }

  async #getRetriever(): Promise<Retriever> {
    this.#assertOpen();

    if (this.#retriever !== undefined && this.#retrieverGeneration === this.#generation) {
      return this.#retriever;
    }

    await this.#retriever?.close();
    this.#retriever = await openRetriever({ config: this.config, embeddingModel: this.registry.embedding });
    this.#retrieverGeneration = this.#generation;
    return this.#retriever;
  }
}
