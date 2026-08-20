import { createLogger } from '../core/logger';
import type { Citation, RetrievedChunk } from '../core/types';

/**
 * STAGE 3 - DELEGATE
 *
 * Shared, mutable state for one agent run.
 *
 * A tool's `execute` is called by the SDK, not by us, so the only way to give
 * tools memory across steps is to close over something. This is that something,
 * and it is doing three jobs that are easy to miss:
 *
 *  1. STABLE CITATION LABELS. If each tool call numbered its own results S1..S5,
 *     then "S2" would mean a different passage in step 1 than in step 3, and the
 *     model's citations would be nonsense. Labels are assigned here, once per
 *     chunk id, for the lifetime of the run.
 *
 *  2. THE EVIDENCE POOL. Every chunk any tool call ever returned is retained.
 *     That lets the final answer be verified against everything the agent saw,
 *     and lets us fall back to a plain Stage 2 answer if the loop runs out of
 *     steps before the model commits.
 *
 *  3. LOOP-GUARD BOOKKEEPING. Repeated-query detection and the retrieval budget
 *     both need history. Without it, an agent that phrases the same failing
 *     query three different ways will burn every step and return nothing.
 */

const log = createLogger('agent:trace');

export interface SearchRecord {
  readonly step: number;
  readonly query: string;
  readonly resultCount: number;
  readonly topScore: number;
  readonly repeated: boolean;
  readonly budgetExhausted: boolean;
}

export interface AgentTrace {
  /** Assign or look up the stable label for a chunk. */
  labelFor(chunk: RetrievedChunk): string;
  /** Record a chunk in the evidence pool. Idempotent. */
  remember(chunk: RetrievedChunk): void;
  /** Has this query (normalised) already been executed? */
  hasSeenQuery(query: string): boolean;
  markQuery(query: string): void;
  /** Previously executed queries, in order, for prompting the rewriter. */
  queries(): readonly string[];
  recordSearch(record: Omit<SearchRecord, 'step'>): void;
  searches(): readonly SearchRecord[];
  /** Remaining retrieval calls before the tool starts refusing. */
  remainingSearches(): number;
  consumeSearch(): boolean;
  /** Everything retrieved this run, best-scoring first. */
  evidence(): readonly RetrievedChunk[];
  citations(): readonly Citation[];
  bumpStep(): void;
  currentStep(): number;
}

export interface AgentTraceOptions {
  /** Hard ceiling on retrieval tool calls per run. */
  readonly maxSearches: number;
}

/** Normalise for repeat detection: casing and punctuation are not intent. */
function normaliseQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function createAgentTrace(options: AgentTraceOptions): AgentTrace {
  const labels = new Map<string, string>();
  const pool = new Map<string, RetrievedChunk>();
  const seenQueries = new Set<string>();
  const queryOrder: string[] = [];
  const searchLog: SearchRecord[] = [];

  let searchesUsed = 0;
  // 1-based: tools execute *during* step 1, but `bumpStep()` only runs when that
  // step finishes. Starting at 0 would label the first step's searches "step 0".
  let step = 1;

  return {
    labelFor(chunk): string {
      const existing = labels.get(chunk.id);
      if (existing !== undefined) return existing;
      const label = `S${labels.size + 1}`;
      labels.set(chunk.id, label);
      return label;
    },

    remember(chunk): void {
      const existing = pool.get(chunk.id);
      // Keep the best score seen for a chunk: a later, worse-phrased query
      // should not downgrade evidence an earlier good query surfaced.
      if (existing === undefined || chunk.score > existing.score) pool.set(chunk.id, chunk);
    },

    hasSeenQuery(query): boolean {
      return seenQueries.has(normaliseQuery(query));
    },

    markQuery(query): void {
      const normalised = normaliseQuery(query);
      if (seenQueries.has(normalised)) return;
      seenQueries.add(normalised);
      queryOrder.push(query.trim());
    },

    queries: () => [...queryOrder],

    recordSearch(record): void {
      searchLog.push({ step, ...record });
      log.debug('search recorded', { step, query: record.query.slice(0, 60), hits: record.resultCount });
    },

    searches: () => [...searchLog],

    remainingSearches: () => Math.max(0, options.maxSearches - searchesUsed),

    consumeSearch(): boolean {
      if (searchesUsed >= options.maxSearches) return false;
      searchesUsed += 1;
      return true;
    },

    evidence: () => [...pool.values()].sort((a, b) => b.score - a.score),

    citations: () =>
      [...pool.values()]
        .map((chunk) => ({
          label: labels.get(chunk.id) ?? 'S?',
          chunkId: chunk.id,
          title: chunk.title,
          relativePath: chunk.relativePath,
          headingPath: chunk.headingPath,
          score: chunk.score,
          origin: 'corpus' as const,
        }))
        .filter((citation) => citation.label !== 'S?')
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),

    bumpStep(): void {
      step += 1;
    },

    currentStep: () => step,
  };
}
