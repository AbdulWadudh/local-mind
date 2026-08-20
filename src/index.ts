/**
 * LocalMind — local-first Agentic RAG on the Vercel AI SDK and LanceDB.
 *
 * The 90% path is the `LocalMind` facade:
 *
 * ```ts
 * import { LocalMind } from 'localmind';
 * import { githubSource, postgresSource } from 'localmind/sources';
 *
 * const mind = await LocalMind.open();
 * await mind.ingestSource(githubSource({ repo: 'vercel/ai' }));
 * await mind.ingestSource(postgresSource({ url: process.env.DATABASE_URL! }));
 *
 * const result = await mind.research('how are retries configured?');
 * console.log(result.answer, result.verification.grounded);
 * ```
 *
 * Everything the facade composes is also exported individually, because the
 * pieces are more useful than the whole for anyone building something that is
 * not shaped like this. Stage boundaries are documented in `docs/`.
 */

/* ── the facade ─────────────────────────────────────────────────────────── */
export { LocalMind, MANUAL_SCOPE } from './localmind';
export type {
  LocalMindOpenOptions,
  IngestSourceResult,
  AskOptions,
  AgentOptions,
  ResearchOptions,
  ProjectSummary,
  RecorderOptions,
} from './localmind';

/* ── observability ──────────────────────────────────────────────────────── */
export { createModelRecorder } from './core/recorder';
export type {
  ModelRecorder,
  ModelCallRecord,
  ModelCallMessage,
  ModelCallStage,
  ModelCallRole,
  ModelCallStats,
  ModelCallQuery,
  CreateModelRecorderOptions,
} from './core/recorder';

/* ── configuration and providers ────────────────────────────────────────── */
export { loadConfig, describeConfig, CHAT_PROVIDERS, EMBEDDING_PROVIDERS, WEB_SEARCH_MODES } from './core/config';
export type { LocalMindConfig, ChatProvider, EmbeddingProvider, WebSearchMode } from './core/config';
export { createModelRegistry, probeEmbeddingDimensions } from './core/providers';
export type { ModelRegistry } from './core/providers';

/* ── errors, logging, budgets ───────────────────────────────────────────── */
export { LocalMindError, describeUnknownError, reportFatal } from './core/errors';
export type { LocalMindErrorCode } from './core/errors';
export { createLogger, writeOut } from './core/logger';
export type { Logger, LogLevel } from './core/logger';
export { estimateTokens, truncateToTokens, createBudget } from './core/tokens';
export { withRetry, safeGenerateObject } from './core/resilience';
export type { StructuredResult } from './core/resilience';

/* ── domain types ───────────────────────────────────────────────────────── */
export type {
  SourceDocument,
  Chunk,
  EmbeddedChunk,
  RetrievedChunk,
  IndexManifest,
  Citation,
  WebResult,
  RetrievalOptions,
  Retriever,
} from './core/types';

/* ── Stage 1: Index ─────────────────────────────────────────────────────── */
export { loadCorpus, createSourceDocument, assertUniqueDocumentIds } from './ingest/loader';
export { chunkDocument, chunkCorpus } from './ingest/chunker';
export type { ChunkOptions, ChunkCorpusResult } from './ingest/chunker';
export { embedChunks, embedQuery } from './ingest/embedder';
export { ingestCorpus } from './ingest/pipeline';
export type { IngestOptions, IngestReport } from './ingest/pipeline';

export { openVectorStore, buildChunkSchema } from './store/vector-store';
export type { VectorStore, SearchOptions, OpenStoreOptions } from './store/vector-store';
export { openDocumentStore, buildDocumentSchema, DOCUMENT_ORIGINS } from './store/document-store';
export type { DocumentStore, CorpusDocument, DocumentOrigin, DocumentQuery } from './store/document-store';
export { readManifest, writeManifest, assertManifestCompatible, manifestPath } from './store/manifest';

export { openRetriever } from './retrieval/retriever';
export type { OpenRetrieverOptions } from './retrieval/retriever';

/* ── corpus (write side) ────────────────────────────────────────────────── */
export { openCorpusService } from './corpus/corpus-service';
export type {
  CorpusService,
  CorpusDocumentInput,
  CorpusWriteResult,
  CorpusStats,
  OpenCorpusServiceOptions,
} from './corpus/corpus-service';

/* ── Stage 2: Ground ────────────────────────────────────────────────────── */
export {
  assembleContext,
  auditCitations,
  normaliseCitationMarkers,
  renderWebSources,
  stitchOverlap,
} from './retrieval/context';
export type { AssembledContext, ContextBlock, CitationAudit, AssembleContextOptions } from './retrieval/context';
export {
  GROUNDED_ANSWER_INSTRUCTIONS,
  QUERY_REWRITE_INSTRUCTIONS,
  INSUFFICIENT_CONTEXT,
  buildGroundedPrompt,
  isAbstention,
} from './generation/prompt';
export { generateGroundedAnswer, streamGroundedAnswer } from './generation/grounded-answer';
export type { GroundedAnswerInput, GroundedAnswerResult, StreamedGroundedAnswer } from './generation/grounded-answer';

/* ── Stage 3: Delegate ──────────────────────────────────────────────────── */
export { createRetrievalTools, FINAL_ANSWER_TOOL } from './agent/tools';
export type { RetrievalTools, RetrievalToolsDeps, SearchToolOutput, ToolHit, FinalAnswerOutput } from './agent/tools';
export { createAgentTrace } from './agent/trace';
export type { AgentTrace, SearchRecord } from './agent/trace';
export { runRetrievalAgent } from './agent/retrieval-agent';
export type { AgentRunResult, AgentStopReason, RunRetrievalAgentOptions } from './agent/retrieval-agent';

/* ── Stage 4: Verify ────────────────────────────────────────────────────── */
export { runSelfCorrectingWorkflow, assertBudgetSane, DEFAULT_BUDGET } from './workflow/graph';
export type {
  WorkflowResult,
  WorkflowBudget,
  WorkflowEvent,
  WorkflowPhase,
  SubQueryOutcome,
  RetrievalAttempt,
  RunWorkflowOptions,
} from './workflow/graph';
export { planQueries } from './workflow/nodes/plan';
export type { QueryPlan, PlanResult } from './workflow/nodes/plan';
export { gradeChunks } from './workflow/nodes/grade';
export type { GradeResult, GradedChunk, Verdict } from './workflow/nodes/grade';
export { rewriteQuery } from './workflow/nodes/rewrite';
export type { RewriteResult, RewriteStrategy } from './workflow/nodes/rewrite';
export { verifyAnswer, buildRepairDirective } from './workflow/nodes/verify';
export type { VerifyResult } from './workflow/nodes/verify';
export { createWebSearchProvider } from './workflow/web-search';
export type { WebSearchProvider, WebSearchOutcome } from './workflow/web-search';
