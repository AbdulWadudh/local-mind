import type { LanguageModel } from 'ai';

import type { CorpusDocumentInput } from '../corpus/corpus-service';

/**
 * The data-source abstraction.
 *
 * A source's only job is to turn *something that is not documents* into
 * documents. It never touches the vector store, never embeds, and never decides
 * how to chunk. That separation is what lets a GitHub repository, a Postgres
 * schema and a hand-typed note flow through exactly the same ingest path and
 * come back as citable evidence with identical guarantees.
 *
 * `ref` is the idempotency key. Re-running a source with the same `ref` replaces
 * every document that run produced (via `removeBySourceRef`), so a re-sync is a
 * clean swap rather than an accumulation of stale duplicates.
 */

export interface SourceProgress {
  readonly stage: string;
  readonly detail?: string;
  readonly done?: number;
  readonly total?: number;
}

export interface SourceContext {
  /**
   * Available for sources that summarise rather than transcribe. Optional on
   * purpose: every source must still produce useful documents without a model,
   * because a model call is the least reliable part of any pipeline.
   */
  readonly chatModel?: LanguageModel;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: SourceProgress) => void;
}

/** An external service the analyzer believes the code depends on. */
export interface DetectedService {
  readonly kind: ServiceKind;
  readonly label: string;
  /** What gave it away: a dependency, a compose service, an env var, an IaC resource. */
  readonly evidence: readonly string[];
  /** Env var names that look like the connection string / credentials. */
  readonly envVars: readonly string[];
  /** True when LocalMind ships a live connector for this kind. */
  readonly connectorAvailable: boolean;
  readonly confidence: 'high' | 'medium' | 'low';
}

export const SERVICE_KINDS = [
  'postgres',
  'mysql',
  'mongodb',
  'redis',
  's3',
  'dynamodb',
  'elasticsearch',
  'openapi',
  'graphql',
  'kafka',
  'rabbitmq',
  'clickhouse',
  'snowflake',
  'bigquery',
  'supabase',
  'firebase',
  'unknown',
] as const;

export type ServiceKind = (typeof SERVICE_KINDS)[number];

export interface SourceCollectResult {
  readonly documents: readonly CorpusDocumentInput[];
  /** Non-fatal problems worth surfacing in the UI. */
  readonly warnings: readonly string[];
  /** Services the source noticed but did not itself ingest. */
  readonly detectedServices: readonly DetectedService[];
  readonly stats: Readonly<Record<string, number | string>>;
}

export interface DataSource {
  readonly kind: string;
  /** Stable idempotency key, e.g. `github:vercel/ai@main`. */
  readonly ref: string;
  readonly label: string;
  collect(context: SourceContext): Promise<SourceCollectResult>;
}

export function emptyResult(overrides: Partial<SourceCollectResult> = {}): SourceCollectResult {
  return {
    documents: [],
    warnings: [],
    detectedServices: [],
    stats: {},
    ...overrides,
  };
}
