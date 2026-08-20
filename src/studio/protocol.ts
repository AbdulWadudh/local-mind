import type { Citation, RetrievedChunk } from '../core/types';
import type { CorpusDocument, DocumentOrigin } from '../store/document-store';
import type { CitationAudit } from '../retrieval/context';
import type { AgentStopReason } from '../agent/retrieval-agent';
import type { SubQueryOutcome, WorkflowPhase } from '../workflow/graph';
import type { VerifyResult } from '../workflow/nodes/verify';
import type { DetectedService } from '../sources/types';
import type { ConnectorDescriptor } from '../sources';
import type { ProjectSummary } from '../localmind';
import type { ModelCallRecord, ModelCallStats } from '../core/recorder';

/**
 * The wire protocol between the Studio API and its UI.
 *
 * Declared once, in the package, and imported by both sides. That is the whole
 * reason this file exists: an SSE stream with an ad-hoc shape is the fastest way
 * to end up with a frontend that silently mis-renders a field the backend
 * renamed. Here a rename is a type error on both sides of the wire.
 */

/**
 * Re-export every type the UI needs from one entrypoint.
 *
 * The Studio client imports only `@localmind/protocol`. Without these
 * re-exports it would have to reach into `../core/types` and
 * `../store/document-store`, and the wire contract would stop being a single
 * file you can read to know what crosses the boundary.
 */
export type { Citation, RetrievedChunk } from '../core/types';
export type { CorpusDocument, DocumentOrigin } from '../store/document-store';
export type { CitationAudit } from '../retrieval/context';
export type { AgentStopReason } from '../agent/retrieval-agent';
export type { SubQueryOutcome, WorkflowPhase, RetrievalAttempt } from '../workflow/graph';
export type { VerifyResult } from '../workflow/nodes/verify';
export type { DetectedService, ServiceKind } from '../sources/types';
export type { ConnectorDescriptor, ConnectorField } from '../sources';
export type { ProjectSummary } from '../localmind';
export type {
  ModelCallRecord,
  ModelCallMessage,
  ModelCallStage,
  ModelCallRole,
  ModelCallStats,
} from '../core/recorder';

export type AnswerMode = 'ask' | 'agent' | 'research';

/* ── chat ────────────────────────────────────────────────────────────────── */

export interface ChatRequest {
  readonly question: string;
  readonly mode: AnswerMode;
  readonly topK?: number;
  readonly minScore?: number;
  /**
   * Restrict retrieval to one ingested source. Omit for the whole corpus.
   *
   * Sent as the `sourceRef` string rather than a resolved id list: the client
   * has no business knowing which documents a project contains, and a list that
   * was accurate when the dropdown rendered would be stale by the time the
   * question is asked.
   */
  readonly sourceRef?: string;
}

/** Progress line rendered in the trace panel. */
export interface TraceEvent {
  readonly kind: 'retrieve' | 'grade' | 'rewrite' | 'web' | 'generate' | 'verify' | 'repair' | 'step' | 'plan' | 'done';
  readonly label: string;
  readonly detail?: string;
  readonly tone?: 'neutral' | 'good' | 'warn' | 'bad';
}

export interface CitationView extends Citation {
  /** Excerpt shown when a citation is expanded in the UI. */
  readonly excerpt?: string;
}

export type ChatEvent =
  /** Emitted once, as soon as retrieval finishes, so sources render before text. */
  | { readonly type: 'sources'; readonly citations: readonly CitationView[] }
  | { readonly type: 'trace'; readonly event: TraceEvent }
  /** Token deltas. Only `ask` mode streams; the others deliver a final answer. */
  | { readonly type: 'delta'; readonly text: string }
  | {
      readonly type: 'done';
      readonly answer: string;
      readonly mode: AnswerMode;
      readonly audit: CitationAudit;
      readonly abstained: boolean;
      readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
      readonly durationMs: number;
      /** Stage 3 only. */
      readonly stopReason?: AgentStopReason;
      readonly confidence?: string;
      /** Stage 4 only. */
      readonly verification?: VerifyResult;
      readonly subQueries?: readonly SubQueryOutcome[];
      readonly repaired?: boolean;
      readonly phases?: readonly WorkflowPhase[];
    }
  | { readonly type: 'error'; readonly code: string; readonly message: string; readonly remedy: string };

/* ── corpus ──────────────────────────────────────────────────────────────── */

export interface CorpusListResponse {
  readonly documents: readonly CorpusDocumentSummary[];
  readonly total: number;
  readonly stats: {
    readonly documents: number;
    readonly chunks: number;
    readonly dimensions: number;
    readonly embeddingModel: string;
    readonly byOrigin: Readonly<Record<string, number>>;
  };
}

/** The list view never needs full document text; sending it makes the list slow. */
export interface CorpusDocumentSummary {
  readonly id: string;
  readonly title: string;
  readonly sourcePath: string;
  readonly origin: DocumentOrigin;
  readonly tags: readonly string[];
  readonly sourceRef: string;
  readonly chunkCount: number;
  readonly charCount: number;
  readonly updatedAt: string;
}

export interface CorpusUpsertRequest {
  readonly id?: string;
  readonly title: string;
  readonly text: string;
  readonly sourcePath?: string;
  readonly tags?: readonly string[];
  readonly origin?: DocumentOrigin;
}

export interface CorpusUpsertResponse {
  readonly document: CorpusDocument;
  readonly chunksWritten: number;
  readonly chunksRemoved: number;
  readonly reembedded: boolean;
}

/* ── sources ─────────────────────────────────────────────────────────────── */

export interface AnalyzeRequest {
  readonly repo?: string;
  readonly path?: string;
  readonly ref?: string;
  readonly token?: string;
  readonly skipSynthesis?: boolean;
}

/** A dry run: what would be ingested, and which services were detected. */
export interface AnalyzePreview {
  readonly sourceRef: string;
  readonly label: string;
  readonly documents: readonly { readonly id: string; readonly title: string; readonly charCount: number }[];
  readonly detectedServices: readonly DetectedService[];
  readonly warnings: readonly string[];
  readonly stats: Readonly<Record<string, number | string>>;
}

export interface IngestRequest {
  readonly kind: string;
  readonly config: Record<string, unknown>;
  /**
   * Write only these preview document ids. Omit to write everything the source
   * produced. Ids come straight from `AnalyzePreview.documents[].id`.
   */
  readonly include?: readonly string[];
}

export interface IngestSummary {
  readonly sourceRef: string;
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

export type SourceEvent =
  | { readonly type: 'progress'; readonly stage: string; readonly detail?: string; readonly done?: number; readonly total?: number }
  | { readonly type: 'preview'; readonly preview: AnalyzePreview }
  | { readonly type: 'ingested'; readonly summary: IngestSummary }
  | { readonly type: 'error'; readonly code: string; readonly message: string; readonly remedy: string };

/* ── health and search ───────────────────────────────────────────────────── */

export interface HealthResponse {
  readonly ok: boolean;
  readonly models: {
    readonly chat: string;
    readonly grader: string;
    readonly embedding: string;
  };
  readonly store: { readonly dbPath: string; readonly tableName: string };
  readonly retrieval: { readonly topK: number; readonly minScore: number; readonly maxContextTokens: number };
  readonly webSearch: string;
  readonly corpus: CorpusListResponse['stats'];
  readonly connectors: readonly ConnectorDescriptor[];
}

export interface SearchRequest {
  readonly query: string;
  readonly topK?: number;
  readonly minScore?: number;
  readonly sourceRef?: string;
}

/** `GET /projects` — the scope picker's options. */
export interface ProjectListResponse {
  readonly projects: readonly ProjectSummary[];
}

/* ── inspect: recorded model calls ───────────────────────────────────────── */

/**
 * `GET /calls` — the prompt/response log.
 *
 * Text is truncated in this response. The list renders 100 calls and a single
 * grounded-answer prompt can be 12 KB, so sending them whole would make the
 * page slower than the pipeline it is meant to explain. `GET /calls/:id` returns
 * one record untruncated.
 */
export interface ModelCallListResponse {
  readonly calls: readonly ModelCallRecord[];
  readonly stats: ModelCallStats;
  /** False when recording was switched off; the UI says so instead of showing an empty list. */
  readonly enabled: boolean;
}

export interface SearchResponse {
  readonly results: readonly RetrievedChunk[];
  readonly durationMs: number;
}
