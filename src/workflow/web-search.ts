import { generateObject } from 'ai';
import type { LanguageModel } from 'ai';
import { createOllama } from 'ai-sdk-ollama';
import { z } from 'zod';

import type { LocalMindConfig, WebSearchMode } from '../core/config';
import { describeUnknownError } from '../core/errors';
import { createLogger } from '../core/logger';
import type { WebResult } from '../core/types';

import { OFFLINE_WEB_CORPUS } from './web-fixtures';

/**
 * STAGE 4 - VERIFY
 *
 * The escape hatch: when the local corpus provably cannot answer, look outward.
 *
 * WHY THIS IS AN INTERFACE AND NOT A FUNCTION
 * Web search is the only part of LocalMind that is inherently non-deterministic
 * and non-local. Putting it behind a two-method interface buys three things:
 *   - the test harness runs the full self-correction loop with zero network,
 *   - the graph's logic is identical whether results came from a fixture or a
 *     live index, so a passing offline test means the *control flow* is right,
 *   - swapping in Tavily/Exa/SearXNG later is one new class, not a refactor.
 *
 * WHY FAILURE IS NOT FATAL
 * A web-search outage must not fail the run. Every provider here degrades to an
 * empty result set with a recorded reason, and the graph treats "no web results"
 * exactly like "no relevant local passages": it abstains. Losing the fallback
 * costs coverage, never correctness.
 */

const log = createLogger('workflow:web');

export interface WebSearchOutcome {
  readonly results: readonly WebResult[];
  readonly mode: WebSearchMode;
  /** Present when the provider failed or was unavailable. */
  readonly failure?: string;
}

export interface WebSearchProvider {
  readonly mode: WebSearchMode;
  readonly describe: string;
  search(query: string, options?: { maxResults?: number; signal?: AbortSignal }): Promise<WebSearchOutcome>;
}

const DEFAULT_MAX_RESULTS = 4;

/**
 * A tool's `execute` may legally return a value, a promise, or an async iterable
 * (for tools that stream partial results). Calling one directly — as we do below
 * — means handling all three. Returning `undefined` for an empty stream keeps
 * the failure explicit rather than producing a half-built object.
 */
async function resolveToolOutput<T>(value: T | AsyncIterable<T>): Promise<T | undefined> {
  if (value !== null && typeof value === 'object' && Symbol.asyncIterator in (value as object)) {
    let last: T | undefined;
    for await (const chunk of value as AsyncIterable<T>) last = chunk;
    return last;
  }
  return value as T;
}

/* ────────────────────────────────────────────────────────────────────────────
 * offline: deterministic fixtures
 * ──────────────────────────────────────────────────────────────────────────── */

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gu, ' ')
    .split(/\s+/u)
    .filter((token) => token.length > 2);
}

/**
 * Fixture "search": token-overlap scoring over a small hand-written corpus.
 *
 * Deliberately crude. Its job is to be *deterministic and explainable* so a
 * failing verify run points at the graph, never at the search backend.
 */
function createOfflineProvider(): WebSearchProvider {
  return {
    mode: 'offline',
    describe: `offline fixtures (${OFFLINE_WEB_CORPUS.length} documents, no network)`,
    search: (query, options) => {
      const queryTokens = new Set(tokenise(query));
      const max = options?.maxResults ?? DEFAULT_MAX_RESULTS;

      const scored = OFFLINE_WEB_CORPUS.map((entry) => {
        const entryTokens = tokenise(`${entry.title} ${entry.snippet} ${entry.keywords.join(' ')}`);
        let hits = 0;
        for (const token of entryTokens) if (queryTokens.has(token)) hits += 1;
        return { entry, score: hits / Math.max(1, queryTokens.size) };
      })
        .filter((candidate) => candidate.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, max);

      log.debug('offline web search', { query: query.slice(0, 60), hits: scored.length });

      return Promise.resolve({
        mode: 'offline' as const,
        results: scored.map(({ entry }) => ({
          title: entry.title,
          url: entry.url,
          snippet: entry.snippet,
        })),
      });
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * ollama: the provider's hosted web_search tool
 * ──────────────────────────────────────────────────────────────────────────── */

function createOllamaProvider(config: LocalMindConfig): WebSearchProvider {
  const ollama = createOllama({
    baseURL: config.ollama.baseUrl,
    ...(config.ollama.apiKey !== undefined ? { apiKey: config.ollama.apiKey } : {}),
  });

  return {
    mode: 'ollama',
    describe: 'ollama hosted web_search tool',
    search: async (query, options) => {
      if (config.ollama.apiKey === undefined) {
        return {
          mode: 'ollama',
          results: [],
          failure: 'OLLAMA_API_KEY is not set; the hosted web_search endpoint requires it.',
        };
      }

      try {
        // The provider ships web search as an AI SDK tool. We are not letting a
        // model call it here - the graph decided to search - so we invoke the
        // tool's `execute` directly with a synthetic execution context.
        const webSearchTool = ollama.tools.webSearch({});
        const executed = await webSearchTool.execute(
          { query, maxResults: options?.maxResults ?? DEFAULT_MAX_RESULTS },
          {
            toolCallId: `localmind-web-${Date.now()}`,
            messages: [],
            context: {},
            ...(options?.signal !== undefined ? { abortSignal: options.signal } : {}),
          },
        );

        const output = await resolveToolOutput(executed);

        // Never trust a tool response's shape, even a typed one: the provider
        // may return an error object with a 200, and the cost of being wrong
        // here is a crash inside the fallback path that exists to prevent
        // crashes.
        if (output === undefined || !Array.isArray(output.results)) {
          return { mode: 'ollama', results: [], failure: 'web_search returned an unexpected payload shape' };
        }

        const results = output.results.map((result) => ({
          title: String(result.title ?? ''),
          url: String(result.url ?? ''),
          snippet: String(result.snippet ?? ''),
        }));

        log.debug('ollama web search', { query: query.slice(0, 60), hits: results.length });
        return { mode: 'ollama', results };
      } catch (error) {
        log.warn('ollama web search failed', { error: describeUnknownError(error) });
        return { mode: 'ollama', results: [], failure: describeUnknownError(error) };
      }
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * openrouter: the ":online" web plugin
 * ──────────────────────────────────────────────────────────────────────────── */

const WebResultsSchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string().describe('Page or article title'),
        url: z.string().describe('Absolute URL of the source'),
        snippet: z.string().describe('2-4 sentences of verbatim relevant text from the page'),
      }),
    )
    .max(8),
});

/**
 * OpenRouter enables its web plugin when you append `:online` to any model slug.
 * The model performs the search and we force the findings into a schema, which
 * keeps the rest of the graph provider-agnostic.
 */
function createOpenRouterProvider(model: LanguageModel, slug: string): WebSearchProvider {
  return {
    mode: 'openrouter',
    describe: `openrouter ":online" web plugin via ${slug}`,
    search: async (query, options) => {
      try {
        const result = await generateObject({
          model,
          schema: WebResultsSchema,
          instructions:
            'Search the web for the query and report what you find. Copy snippets verbatim from the pages; never paraphrase or invent. Every result must have a real, complete URL you actually retrieved. If you find nothing, return an empty results array.',
          prompt: query,
          temperature: 0,
          ...(options?.signal !== undefined ? { abortSignal: options.signal } : {}),
        });

        const results = result.object.results
          .filter((entry) => /^https?:\/\//u.test(entry.url))
          .slice(0, options?.maxResults ?? DEFAULT_MAX_RESULTS);

        log.debug('openrouter web search', { query: query.slice(0, 60), hits: results.length });
        return { mode: 'openrouter', results };
      } catch (error) {
        log.warn('openrouter web search failed', { error: describeUnknownError(error) });
        return { mode: 'openrouter', results: [], failure: describeUnknownError(error) };
      }
    },
  };
}

export interface CreateWebSearchOptions {
  readonly config: LocalMindConfig;
  /**
   * Factory for the `:online` model. Injected so this module never builds a
   * registry of its own (and so the harness can pass a mock).
   */
  readonly onlineModelFactory?: (slug: string) => LanguageModel;
}

export function createWebSearchProvider(options: CreateWebSearchOptions): WebSearchProvider {
  const { config } = options;

  switch (config.webSearch.mode) {
    case 'offline':
      return createOfflineProvider();

    case 'ollama':
      return createOllamaProvider(config);

    case 'openrouter': {
      const slug = `${config.chat.model}:online`;
      const factory = options.onlineModelFactory;
      if (factory === undefined) {
        log.warn('no online model factory supplied; falling back to offline fixtures');
        return createOfflineProvider();
      }
      return createOpenRouterProvider(factory(slug), slug);
    }

    default: {
      // Exhaustiveness guard: adding a mode to the union without handling it
      // here becomes a compile error rather than a silent fallthrough.
      const exhaustive: never = config.webSearch.mode;
      throw new Error(`Unhandled web search mode: ${String(exhaustive)}`);
    }
  }
}
