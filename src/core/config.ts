import { z } from 'zod';
import { LocalMindError } from './errors';

/**
 * Configuration is parsed once, validated with Zod, and then passed explicitly
 * to everything that needs it. Nothing in `src/` reads `process.env` directly
 * except this file — which is what makes the offline test harness able to
 * construct a config object by hand and run the whole pipeline deterministically.
 */

export const CHAT_PROVIDERS = ['ollama', 'openrouter'] as const;
export const EMBEDDING_PROVIDERS = ['ollama', 'openrouter'] as const;
export const WEB_SEARCH_MODES = ['offline', 'ollama', 'openrouter'] as const;

export type ChatProvider = (typeof CHAT_PROVIDERS)[number];
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number];
export type WebSearchMode = (typeof WEB_SEARCH_MODES)[number];

/**
 * The OpenRouter default is a *pinned* free model, not the `openrouter/free`
 * auto-router, and the reason is worth knowing before you change it.
 *
 * `openrouter/free` is appealing: $0/token, 200k context, and it advertises
 * `tools` + `structured_outputs`. But it selects a random free model per
 * request, so two identical runs can be served by two different models — and in
 * practice one of them will occasionally be a model that ignores your
 * instructions entirely. A real observed response to a grounded-answer prompt
 * was the single line "User Safety: safe". Nothing errored; the answer was just
 * garbage. That is an acceptable trade for a chat toy and a poor one for a
 * pipeline whose whole purpose is verifiable grounding.
 *
 * The default is `openrouter/free` anyway, because zero-configuration matters
 * more here than determinism: it needs no model research, no allow-list to go
 * stale as free tiers rotate, and it cannot 404 the way a pinned slug does when
 * a provider retires it.
 *
 * WHAT THAT COSTS, AND WHY THE PIPELINE SURVIVES IT
 *
 * Every defensive layer in this codebase exists because of exactly this class of
 * model, and the router is the honest test of them:
 *
 *   - `safeGenerateObject` returns a Result instead of throwing, so a model that
 *     cannot produce schema-valid JSON degrades a node rather than the run.
 *   - `plan` and `grade` fail *open*; `verify` fails *closed*. A router model
 *     that returns nonsense therefore costs a planning step, not a false
 *     "grounded" verdict.
 *   - `normaliseCitationMarkers` handles the citation punctuation each model
 *     invents — 【S1】, ［S1］, `[S1, S2]`. Without it, a model whose only sin is
 *     unusual brackets is scored as having cited nothing at all.
 *   - `withRetry` re-rolls, and because routing is per-request a retry is
 *     usually served by a *different* model. Retrying a flaky router is
 *     unusually effective for that reason.
 *
 * Pin a slug if you want a fixed baseline for measurement:
 *
 *   LOCALMIND_CHAT_MODEL=nvidia/nemotron-3-super-120b-a12b:free
 *
 * That one was verified to emit well-formed tool calls and schema-valid
 * structured output — the two capabilities stages 3 and 4 cannot run without —
 * and has a 262k context window. `openai/gpt-oss-20b:free` also works.
 */
const CHAT_MODEL_DEFAULTS: Readonly<Record<ChatProvider, string>> = {
  ollama: 'llama3.1:8b',
  openrouter: 'openrouter/free',
};

/**
 * Embeddings default to OpenRouter, using `nvidia/nemotron-3-embed-1b:free`.
 *
 * Staying local costs nothing in quality and keeps the corpus on the machine:
 * `nomic-embed-text` is 768-dim, fast on CPU, and never leaves the host. That is
 * the right choice where Ollama can be installed. Three options, measured on this
 * repo's own corpus with the query "why is cosine better than euclidean for
 * text":
 *
 *   nomic-embed-text                  768d  top hit 0.772  needs Ollama
 *   openai/text-embedding-3-small    1536d  top hit 0.549  paid, strongest recall
 *   nvidia/nemotron-3-embed-1b:free  2048d  top hit 0.571  free, the default here
 *
 * The free model is the default because a paid key should never be the only way
 * to run this. It is measurably weaker at ranking, though: on that query it put
 * a related chunk above the one literally titled "Cosine similarity versus
 * Euclidean distance", which `nomic-embed-text` ordered correctly. Switch to the
 * OpenAI model if recall matters more than cost.
 *
 * SCORES ARE NOT COMPARABLE ACROSS MODELS. Each model has its own similarity
 * distribution, so `LOCALMIND_MIN_SCORE` is tuned per model, not once. The
 * default of 0.25 suits `nomic-embed-text`; on `nemotron-3-embed-1b` on-topic
 * chunks landed at 0.26-0.57, which clears the floor but with little margin.
 * Run `bun run search` against a known query after switching and look at where
 * the good hits actually fall before trusting the threshold.
 *
 * Changing the embedding model changes the vector dimensions, so the index must
 * be rebuilt (`bun run ingest --rebuild`). Querying across two vector spaces is
 * caught by the manifest check rather than silently returning noise.
 */
const EMBEDDING_MODEL_DEFAULTS: Readonly<Record<EmbeddingProvider, string>> = {
  ollama: 'nomic-embed-text',
  openrouter: 'nvidia/nemotron-3-embed-1b:free',
};

/**
 * Raw env shape. Everything is a string or undefined at this point; coercion and
 * defaulting happen in `ConfigSchema` so the error messages name the env var.
 */
const EnvSchema = z.object({
  LOCALMIND_CHAT_PROVIDER: z.enum(CHAT_PROVIDERS).default('ollama'),
  LOCALMIND_CHAT_MODEL: z.string().min(1).optional(),
  LOCALMIND_GRADER_MODEL: z.string().min(1).optional(),

  LOCALMIND_EMBEDDING_PROVIDER: z.enum(EMBEDDING_PROVIDERS).default('openrouter'),
  LOCALMIND_EMBEDDING_MODEL: z.string().min(1).optional(),

  OLLAMA_BASE_URL: z.string().url().default('http://127.0.0.1:11434'),
  OLLAMA_API_KEY: z.string().min(1).optional(),
  OPENROUTER_API_KEY: z.string().min(1).optional(),

  LOCALMIND_DB_PATH: z.string().min(1).default('.data/lancedb'),
  LOCALMIND_TABLE: z.string().min(1).default('chunks'),
  LOCALMIND_CORPUS_DIR: z.string().min(1).default('corpus'),

  LOCALMIND_CHUNK_CHARS: z.coerce.number().int().min(200).max(8000).default(1200),
  LOCALMIND_CHUNK_OVERLAP: z.coerce.number().int().min(0).max(2000).default(180),

  LOCALMIND_TOP_K: z.coerce.number().int().min(1).max(50).default(6),
  LOCALMIND_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.25),
  LOCALMIND_MAX_CONTEXT_TOKENS: z.coerce.number().int().min(256).max(200_000).default(3000),
  LOCALMIND_MAX_AGENT_STEPS: z.coerce.number().int().min(2).max(40).default(8),

  LOCALMIND_WEB_SEARCH: z.enum(WEB_SEARCH_MODES).default('offline'),
});

export interface LocalMindConfig {
  readonly chat: {
    readonly provider: ChatProvider;
    readonly model: string;
    /** Cheap, high-volume structured calls (grading, verification). */
    readonly graderModel: string;
  };
  readonly embedding: {
    readonly provider: EmbeddingProvider;
    readonly model: string;
  };
  readonly ollama: {
    readonly baseUrl: string;
    readonly apiKey?: string;
  };
  readonly openrouter: {
    readonly apiKey?: string;
  };
  readonly store: {
    readonly dbPath: string;
    readonly tableName: string;
    readonly corpusDir: string;
  };
  readonly chunking: {
    readonly maxChars: number;
    readonly overlapChars: number;
  };
  readonly retrieval: {
    readonly topK: number;
    readonly minScore: number;
    readonly maxContextTokens: number;
  };
  readonly agent: {
    readonly maxSteps: number;
  };
  readonly webSearch: {
    readonly mode: WebSearchMode;
  };
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/** Parse and validate configuration from an env-like record. */
export function loadConfig(source: Record<string, string | undefined> = process.env): LocalMindConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new LocalMindError('CONFIG_INVALID', `Invalid LocalMind configuration: ${formatZodIssues(parsed.error)}`, {
      remedy: 'Fix the offending environment variable, or delete it to fall back to the documented default (see .env.example).',
    });
  }

  const env = parsed.data;

  if (env.LOCALMIND_CHUNK_OVERLAP >= env.LOCALMIND_CHUNK_CHARS) {
    throw new LocalMindError(
      'CONFIG_INVALID',
      `LOCALMIND_CHUNK_OVERLAP (${env.LOCALMIND_CHUNK_OVERLAP}) must be smaller than LOCALMIND_CHUNK_CHARS (${env.LOCALMIND_CHUNK_CHARS}).`,
      {
        remedy: 'An overlap >= the chunk size makes the splitter emit the same window forever. Keep overlap at roughly 10-20% of chunk size.',
      },
    );
  }

  const chatModel = env.LOCALMIND_CHAT_MODEL ?? CHAT_MODEL_DEFAULTS[env.LOCALMIND_CHAT_PROVIDER];
  const embeddingModel =
    env.LOCALMIND_EMBEDDING_MODEL ?? EMBEDDING_MODEL_DEFAULTS[env.LOCALMIND_EMBEDDING_PROVIDER];

  const needsOpenRouterKey =
    env.LOCALMIND_CHAT_PROVIDER === 'openrouter' ||
    env.LOCALMIND_EMBEDDING_PROVIDER === 'openrouter' ||
    env.LOCALMIND_WEB_SEARCH === 'openrouter';

  if (needsOpenRouterKey && env.OPENROUTER_API_KEY === undefined) {
    throw new LocalMindError('CONFIG_INVALID', 'OPENROUTER_API_KEY is required when any provider is set to "openrouter".', {
      remedy: 'Set OPENROUTER_API_KEY in .env, or switch LOCALMIND_CHAT_PROVIDER / LOCALMIND_EMBEDDING_PROVIDER / LOCALMIND_WEB_SEARCH back to their local defaults.',
      details: {
        chatProvider: env.LOCALMIND_CHAT_PROVIDER,
        embeddingProvider: env.LOCALMIND_EMBEDDING_PROVIDER,
        webSearch: env.LOCALMIND_WEB_SEARCH,
      },
    });
  }

  return {
    chat: {
      provider: env.LOCALMIND_CHAT_PROVIDER,
      model: chatModel,
      graderModel: env.LOCALMIND_GRADER_MODEL ?? chatModel,
    },
    embedding: {
      provider: env.LOCALMIND_EMBEDDING_PROVIDER,
      model: embeddingModel,
    },
    ollama: {
      baseUrl: env.OLLAMA_BASE_URL,
      ...(env.OLLAMA_API_KEY !== undefined ? { apiKey: env.OLLAMA_API_KEY } : {}),
    },
    openrouter: {
      ...(env.OPENROUTER_API_KEY !== undefined ? { apiKey: env.OPENROUTER_API_KEY } : {}),
    },
    store: {
      dbPath: env.LOCALMIND_DB_PATH,
      tableName: env.LOCALMIND_TABLE,
      corpusDir: env.LOCALMIND_CORPUS_DIR,
    },
    chunking: {
      maxChars: env.LOCALMIND_CHUNK_CHARS,
      overlapChars: env.LOCALMIND_CHUNK_OVERLAP,
    },
    retrieval: {
      topK: env.LOCALMIND_TOP_K,
      minScore: env.LOCALMIND_MIN_SCORE,
      maxContextTokens: env.LOCALMIND_MAX_CONTEXT_TOKENS,
    },
    agent: {
      maxSteps: env.LOCALMIND_MAX_AGENT_STEPS,
    },
    webSearch: {
      mode: env.LOCALMIND_WEB_SEARCH,
    },
  };
}

/** Human-readable one-liner used by every CLI banner. */
export function describeConfig(config: LocalMindConfig): string {
  return [
    `chat=${config.chat.provider}/${config.chat.model}`,
    `embed=${config.embedding.provider}/${config.embedding.model}`,
    `db=${config.store.dbPath}#${config.store.tableName}`,
    `topK=${config.retrieval.topK}`,
    `web=${config.webSearch.mode}`,
  ].join('  ');
}
