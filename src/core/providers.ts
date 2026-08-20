import { embed } from 'ai';
import type { EmbeddingModel, LanguageModel } from 'ai';
import { createOllama } from 'ai-sdk-ollama';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

import type { LocalMindConfig } from './config';
import { LocalMindError, describeUnknownError } from './errors';
import { createLogger } from './logger';

/**
 * Provider-agnostic model resolution.
 *
 * Every downstream module takes a `LanguageModel` or an `EmbeddingModel` and
 * never learns whether it is talking to a 4 GB local GGUF or a hosted frontier
 * model. That is the whole point: the RAG and agent logic in stages 1-4 is
 * written once and stays provider-invariant.
 *
 * WHY NOT `createProviderRegistry`
 * The obvious implementation is the AI SDK's registry, giving
 * `"<provider>:<model>"` addressing with a compile-time-checked template literal
 * id. It is a genuinely nice API, and it was the first thing tried here. It also
 * has a trap that cost a debugging session and is worth documenting:
 *
 *   The registry resolves a language model by calling `provider.languageModel(id)`.
 *   `@openrouter/ai-sdk-provider` overloads that method, and the *first* overload
 *   returns an `OpenRouterCompletionLanguageModel` - the legacy text-completion
 *   endpoint, on the older provider specification. So every chat call silently
 *   went through a compatibility shim ("Using v2 specification compatibility
 *   mode. Some features may not be available"), which is exactly the sort of
 *   half-working path that produces mysterious tool-calling failures later.
 *
 * Resolving with an explicit `.chat()` per provider is three lines longer and has
 * no ambiguity. Both providers are still constructed unconditionally: neither
 * performs I/O nor validates credentials at construction time, so this cannot
 * fail, and a missing key surfaces at the first call - where `loadConfig` has
 * already guaranteed it is present for the selected provider.
 */

const log = createLogger('providers');

export interface ModelRegistry {
  readonly chat: LanguageModel;
  /** Cheap model for high-volume structured calls (grading, verification). */
  readonly grader: LanguageModel;
  readonly embedding: EmbeddingModel;
  readonly describe: () => string;
}

export function createModelRegistry(config: LocalMindConfig): ModelRegistry {
  const ollama = createOllama({
    baseURL: config.ollama.baseUrl,
    ...(config.ollama.apiKey !== undefined ? { apiKey: config.ollama.apiKey } : {}),
  });

  const openrouter = createOpenRouter({
    ...(config.openrouter.apiKey !== undefined ? { apiKey: config.openrouter.apiKey } : {}),
  });

  const chatModel = (modelId: string): LanguageModel =>
    config.chat.provider === 'ollama' ? ollama.chat(modelId) : openrouter.chat(modelId);

  const embeddingModel = (modelId: string): EmbeddingModel =>
    config.embedding.provider === 'ollama'
      ? ollama.textEmbeddingModel(modelId)
      : openrouter.textEmbeddingModel(modelId);

  const chatId = `${config.chat.provider}:${config.chat.model}`;
  const graderId = `${config.chat.provider}:${config.chat.graderModel}`;
  const embeddingId = `${config.embedding.provider}:${config.embedding.model}`;

  log.debug('models resolved', { chat: chatId, grader: graderId, embedding: embeddingId });

  return {
    chat: chatModel(config.chat.model),
    grader: chatModel(config.chat.graderModel),
    embedding: embeddingModel(config.embedding.model),
    describe: () => `${chatId} | grader=${graderId} | embed=${embeddingId}`,
  };
}

/**
 * Ask the embedding model for its own dimensionality by embedding a sentinel.
 *
 * There is no portable metadata endpoint for this across providers, and the
 * LanceDB schema needs an exact `FixedSizeList(dim)` *before* the first row is
 * written. One probe call at ingest time is far cheaper than guessing wrong and
 * having to rebuild the table.
 */
export async function probeEmbeddingDimensions(
  model: EmbeddingModel,
  options: { signal?: AbortSignal } = {},
): Promise<number> {
  try {
    const result = await embed({
      model,
      value: 'localmind dimension probe',
      maxRetries: 1,
      ...(options.signal !== undefined ? { abortSignal: options.signal } : {}),
    });

    const dimensions = result.embedding.length;
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new LocalMindError('EMBEDDING_FAILED', `Embedding model returned a ${dimensions}-dimension vector.`, {
        remedy: 'The configured model is probably not an embedding model. Check LOCALMIND_EMBEDDING_MODEL.',
        details: { dimensions },
      });
    }

    log.debug('probed embedding dimensions', { dimensions });
    return dimensions;
  } catch (error) {
    if (LocalMindError.is(error)) throw error;
    throw new LocalMindError(
      'PROVIDER_UNAVAILABLE',
      `Could not reach the embedding model: ${describeUnknownError(error)}`,
      {
        remedy:
          'Run `bun run doctor` to check the provider endpoint, then confirm the model is pulled (`ollama pull <model>`) or that OPENROUTER_API_KEY is valid.',
        cause: error,
      },
    );
  }
}
