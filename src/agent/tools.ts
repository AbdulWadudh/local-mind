import { tool } from 'ai';
import { z } from 'zod';

import { createLogger } from '../core/logger';
import { describeUnknownError } from '../core/errors';
import { estimateTokens, truncateToTokens } from '../core/tokens';
import type { Retriever } from '../core/types';

import type { AgentTrace } from './trace';

/**
 * STAGE 3 - DELEGATE
 *
 * Retrieval, exposed as tools the model can choose to call.
 *
 * Stage 2 retrieved exactly once, for exactly the user's words. That fails
 * whenever the question is compound ("how do I chunk AND what index type
 * should I use"), conversational ("why is it so slow"), or simply worded
 * differently from the corpus. Handing the model a `searchKnowledgeBase` tool
 * lets it translate, decompose and retry.
 *
 * The cost of that freedom is three new failure modes. All three are handled
 * here rather than hoped away:
 *
 *  A. INFINITE / DEGENERATE LOOPS. A model whose query returns nothing will
 *     often retry the same query, or a trivial re-wording, forever.
 *     -> Normalised repeat detection. A repeated query does NOT re-run the
 *        search; it returns a steering message telling the model what it already
 *        tried and what to do instead. Cheaper than a search and strictly more
 *        informative than a second empty result.
 *
 *  B. TOOL-RESULT CONTEXT BLOWUP. Tool results are appended to the conversation
 *     and re-sent on every subsequent step. Six 300-token chunks over four steps
 *     is ~7k tokens of duplicated evidence, which on a 8k-context local model
 *     silently evicts the instructions.
 *     -> A per-call token budget, enforced by truncation, plus a hard cap on the
 *        number of searches per run.
 *
 *  C. UNGROUNDABLE CITATIONS. If the tool returns bare prose, the model has
 *     nothing to cite.
 *     -> Every hit carries its run-stable `[S#]` label, assigned by the trace.
 */

const log = createLogger('agent:tools');

/** Token budget for a single tool result. Small on purpose; see (B) above. */
const PER_CALL_TOKEN_BUDGET = 900;

/** Longest single excerpt, so one huge chunk cannot consume the whole budget. */
const MAX_EXCERPT_TOKENS = 320;

export interface RetrievalToolsDeps {
  readonly retriever: Retriever;
  readonly trace: AgentTrace;
  readonly defaultTopK: number;
  readonly minScore: number;
  readonly signal?: AbortSignal;
}

/** Shape returned to the model for one retrieved passage. */
export interface ToolHit {
  readonly label: string;
  readonly title: string;
  readonly section: string;
  readonly path: string;
  readonly relevance: number;
  readonly excerpt: string;
  readonly excerptTruncated: boolean;
}

export interface SearchToolOutput {
  readonly status: 'ok' | 'no-results' | 'repeated-query' | 'budget-exhausted';
  readonly query: string;
  readonly hits: readonly ToolHit[];
  /** Instructions to the model about what to do next. Always present. */
  readonly guidance: string;
  readonly searchesRemaining: number;
}

export const FINAL_ANSWER_TOOL = 'finalAnswer';

export interface FinalAnswerOutput {
  readonly answer: string;
  readonly citedLabels: readonly string[];
  readonly confidence: 'high' | 'medium' | 'low' | 'insufficient';
}

export function createRetrievalTools(deps: RetrievalToolsDeps) {
  const { retriever, trace } = deps;

  const searchKnowledgeBase = tool({
    description: [
      'Semantic search over the indexed local knowledge base. Returns passages with citation labels.',
      'Call this once per distinct sub-question. Prefer the terminology the documentation would use over the user',
      "phrasing. If a query returns nothing useful, reformulate it - do not repeat it.",
    ].join(' '),
    inputSchema: z.object({
      query: z
        .string()
        .min(3, 'query must be at least 3 characters')
        .max(300, 'query must be under 300 characters')
        .describe(
          'A focused search query in the vocabulary of technical documentation. One topic per call. Not a full sentence question.',
        ),
      topK: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('How many passages to return. Defaults to the configured value. Raise only for broad survey questions.'),
    }),
    execute: async ({ query, topK }): Promise<SearchToolOutput> => {
      const searchesRemaining = trace.remainingSearches();

      // GUARD A: repeated query. Answer from history instead of re-searching.
      if (trace.hasSeenQuery(query)) {
        trace.recordSearch({ query, resultCount: 0, topScore: 0, repeated: true, budgetExhausted: false });
        log.warn('repeated query blocked', { query: query.slice(0, 60) });

        return {
          status: 'repeated-query',
          query,
          hits: [],
          searchesRemaining,
          guidance: [
            `You have already searched for "${query}". Repeating it will return the same passages.`,
            `Queries already tried: ${trace.queries().map((q) => `"${q}"`).join(', ')}.`,
            'Either search for a materially different term, or call',
            `${FINAL_ANSWER_TOOL} with what you have. If the knowledge base genuinely lacks this information,`,
            `call ${FINAL_ANSWER_TOOL} with confidence "insufficient".`,
          ].join(' '),
        };
      }

      // GUARD B: retrieval budget.
      if (!trace.consumeSearch()) {
        trace.recordSearch({ query, resultCount: 0, topScore: 0, repeated: false, budgetExhausted: true });
        log.warn('retrieval budget exhausted', { query: query.slice(0, 60) });

        return {
          status: 'budget-exhausted',
          query,
          hits: [],
          searchesRemaining: 0,
          guidance: `The retrieval budget for this turn is spent. Call ${FINAL_ANSWER_TOOL} now using the passages you already have.`,
        };
      }

      trace.markQuery(query);

      let results: Awaited<ReturnType<Retriever['search']>>;
      try {
        results = await retriever.search(query, {
          topK: topK ?? deps.defaultTopK,
          minScore: deps.minScore,
        });
      } catch (error) {
        // A thrown tool error aborts the whole generation. Returning the failure
        // as data lets the model try a different query instead.
        log.error('retrieval failed inside tool', { error: describeUnknownError(error) });
        return {
          status: 'no-results',
          query,
          hits: [],
          searchesRemaining: trace.remainingSearches(),
          guidance: `The search backend returned an error: ${describeUnknownError(error)}. Try one different query; if it fails again, call ${FINAL_ANSWER_TOOL} with confidence "insufficient".`,
        };
      }

      if (results.length === 0) {
        trace.recordSearch({ query, resultCount: 0, topScore: 0, repeated: false, budgetExhausted: false });
        return {
          status: 'no-results',
          query,
          hits: [],
          searchesRemaining: trace.remainingSearches(),
          guidance: [
            `No passage scored above the relevance threshold for "${query}".`,
            'Reformulate: use documentation terminology, drop conversational words, or generalise by one level.',
            `Already tried: ${trace.queries().map((q) => `"${q}"`).join(', ')}.`,
          ].join(' '),
        };
      }

      // GUARD B (cont.): spend a per-call token budget across the hits.
      const hits: ToolHit[] = [];
      let spent = 0;

      for (const chunk of results) {
        trace.remember(chunk);
        const label = trace.labelFor(chunk);

        const allowance = Math.min(MAX_EXCERPT_TOKENS, PER_CALL_TOKEN_BUDGET - spent);
        if (allowance <= 40) break; // no room left for anything meaningful

        const { text, truncated } = truncateToTokens(chunk.text, allowance);
        spent += estimateTokens(text);

        hits.push({
          label,
          title: chunk.title,
          section: chunk.headingPath,
          path: chunk.relativePath,
          relevance: Number(chunk.score.toFixed(3)),
          excerpt: text,
          excerptTruncated: truncated,
        });
      }

      const topScore = results[0]?.score ?? 0;
      trace.recordSearch({
        query,
        resultCount: hits.length,
        topScore,
        repeated: false,
        budgetExhausted: false,
      });

      const weak = topScore < deps.minScore + 0.1;

      return {
        status: 'ok',
        query,
        hits,
        searchesRemaining: trace.remainingSearches(),
        guidance: weak
          ? `Top relevance is only ${topScore.toFixed(2)}; these passages may be tangential. Consider one more query with different terms before answering.`
          : `Cite these passages by their label, e.g. [${hits[0]?.label ?? 'S1'}]. When you can answer, call ${FINAL_ANSWER_TOOL}.`,
      };
    },
  });

  const listKnowledgeSources = tool({
    description:
      'List the documents in the knowledge base with their chunk counts. Use this once when you need to know what the corpus covers before searching, or to tell the user a topic is absent.',
    inputSchema: z.object({}),
    execute: async (): Promise<{
      documents: readonly { title: string; path: string; chunks: number }[];
      guidance: string;
    }> => {
      const sources = await retriever.listSources();
      return {
        documents: sources.map((source) => ({
          title: source.title,
          path: source.relativePath,
          chunks: source.chunkCount,
        })),
        guidance:
          'These are the only documents available. If the question is about a topic not covered here, say so instead of searching repeatedly.',
      };
    },
  });

  /**
   * The terminal tool.
   *
   * Its purpose is control flow, not computation: paired with
   * `hasToolCall('finalAnswer')` it gives the loop a deterministic exit that the
   * model chooses explicitly. Without it, "done" is inferred from the model
   * emitting text instead of a tool call - which small models do accidentally,
   * mid-reasoning, all the time.
   */
  const finalAnswer = tool({
    description:
      'Submit the final answer and stop. Every factual sentence must carry a citation label from the search results, e.g. [S1]. Call this exactly once.',
    inputSchema: z.object({
      answer: z
        .string()
        .min(1)
        .describe(
          'The complete answer in markdown, with inline [S#] citations on every factual sentence. If the knowledge base cannot answer, explain precisely what is missing.',
        ),
      citedLabels: z
        .array(z.string().regex(/^S\d+$/u, 'labels look like S1, S2, ...'))
        .describe('Every citation label used in `answer`. Must match the labels returned by searchKnowledgeBase.'),
      confidence: z
        .enum(['high', 'medium', 'low', 'insufficient'])
        .describe(
          'high = directly stated in the sources; medium = assembled from several passages; low = weakly supported; insufficient = the corpus does not contain the answer.',
        ),
    }),
    execute: async (input): Promise<FinalAnswerOutput> => {
      log.debug('final answer submitted', {
        confidence: input.confidence,
        labels: input.citedLabels.length,
        chars: input.answer.length,
      });
      return input;
    },
  });

  return { searchKnowledgeBase, listKnowledgeSources, finalAnswer } as const;
}

export type RetrievalTools = ReturnType<typeof createRetrievalTools>;
