import { wrapLanguageModel } from 'ai';
import type { LanguageModel, LanguageModelMiddleware } from 'ai';

import { describeUnknownError } from './errors';
import { createLogger } from './logger';
import { estimateTokens } from './tokens';

/**
 * Model-call recorder.
 *
 * WHAT THIS IS FOR
 *
 * When a grounded answer is wrong, the first question is never "what did the
 * model say" — it is "what did we actually send it". A RAG pipeline builds its
 * own prompts: chunks are selected, stitched, truncated to a token budget and
 * wrapped in instructions, and every one of those steps can be the bug. Without
 * a record of the assembled prompt you are debugging the retriever by reading
 * the answer, which is guessing.
 *
 * WHY MIDDLEWARE AND NOT LOGGING AT THE CALL SITES
 *
 * `wrapLanguageModel` intercepts at the provider boundary, which buys three
 * things call-site logging cannot:
 *
 *   1. It sees the prompt as the *provider* sees it — after the SDK has merged
 *      `instructions` into a system message and serialised tool definitions. A
 *      call site can only log what it passed in, which is not the same object.
 *   2. It is provider-agnostic. OpenRouter over HTTP and Ollama over localhost
 *      arrive at the same interface, so "track it whether the model is an API or
 *      local" needs no branching at all.
 *   3. It cannot be forgotten. A new stage added later is recorded because it
 *      uses the registry, not because someone remembered to add a log line.
 *
 * WHAT IS NOT RECORDED
 *
 * Request headers, and `result.request.body`. Headers carry the OpenRouter
 * bearer token, and the raw body would carry it back in echo form on some
 * providers. Prompts and completions only — the corpus content is the user's own
 * data, an API key is not.
 *
 * MEMORY
 *
 * A prompt carrying a 3000-token context block is ~12 KB, and a repository
 * analysis can issue dozens back to back. So the buffer is bounded on BOTH axes:
 * a record count and a total byte budget, whichever binds first. Bounding only
 * the count is how an observability feature becomes the memory leak it was
 * meant to help diagnose.
 */

const log = createLogger('recorder');

/** Which registry model served the call. Known exactly, never inferred. */
export type ModelCallRole = 'chat' | 'grader';

/**
 * The pipeline stage a call belongs to.
 *
 * `unknown` is a real outcome, not a bug: a consumer composing the exported
 * primitives directly gets calls this classifier has never seen, and labelling
 * those as something specific would be worse than admitting ignorance.
 */
export type ModelCallStage =
  | 'ground'
  | 'agent'
  | 'plan'
  | 'grade'
  | 'rewrite'
  | 'verify'
  | 'analyze'
  | 'unknown';

export interface ModelCallMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly text: string;
}

export interface ModelCallRecord {
  readonly id: string;
  /** ISO timestamp of the moment the call left for the provider. */
  readonly startedAt: string;
  readonly role: ModelCallRole;
  readonly stage: ModelCallStage;
  readonly operation: 'generate' | 'stream';
  readonly provider: string;
  readonly modelId: string;

  /** The system message, i.e. the stage's instructions as the provider saw them. */
  readonly system?: string;
  /** Everything after the system message, in order. */
  readonly messages: readonly ModelCallMessage[];
  /** Tool names offered on this call. Empty for plain generation. */
  readonly tools: readonly string[];
  readonly settings: {
    readonly temperature?: number;
    readonly maxOutputTokens?: number;
    /** Set when the call asked for structured output. */
    readonly responseFormat?: 'text' | 'json';
  };

  /** Assembled response text. Empty when the model only called tools. */
  readonly responseText: string;
  /** Tool calls the model made, as `name(args)` summaries. */
  readonly toolCalls: readonly string[];
  readonly finishReason?: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
  };
  /** Our own estimate, so a provider that reports no usage still has a number. */
  readonly estimatedPromptTokens: number;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly error?: string;
  readonly warnings: readonly string[];
}

/** Summary shown above the list, computed over everything still buffered. */
export interface ModelCallStats {
  readonly total: number;
  readonly failed: number;
  readonly byStage: Readonly<Record<string, number>>;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalDurationMs: number;
  readonly slowestMs: number;
  /** Approximate heap held by the buffer, so the cost is visible. */
  readonly bufferBytes: number;
  readonly capacity: number;
  readonly evicted: number;
}

export interface ModelCallQuery {
  readonly stage?: ModelCallStage;
  readonly role?: ModelCallRole;
  /** `true` for failures only, `false` for successes only. */
  readonly failedOnly?: boolean;
  /** Case-insensitive substring over the prompt and the response. */
  readonly search?: string;
  readonly limit?: number;
}

export interface ModelRecorder {
  /** Wrap a model so every call through it is recorded. */
  wrap(model: LanguageModel, role: ModelCallRole): LanguageModel;
  /** Newest first. Text is truncated for transport; use `get` for the whole thing. */
  list(query?: ModelCallQuery): readonly ModelCallRecord[];
  /** One record, untruncated. */
  get(id: string): ModelCallRecord | undefined;
  stats(): ModelCallStats;
  /** Drop one record. Returns false if it was already gone. */
  remove(id: string): boolean;
  /** Returns how many records were dropped. */
  clear(): number;
  readonly enabled: boolean;
}

export interface CreateModelRecorderOptions {
  /** Maximum records retained. Default 200. */
  readonly capacity?: number;
  /** Maximum approximate bytes retained. Default 8 MB. */
  readonly maxBytes?: number;
  /**
   * Maps a system prompt to a stage. Injected rather than built in, because
   * `core` must not import the stages — `grade.ts` already imports `core`, and
   * reaching back the other way would make the dependency graph a cycle.
   */
  readonly classify?: (system: string | undefined) => ModelCallStage;
  /** Set false to make every method a no-op. */
  readonly enabled?: boolean;
}

/** Longest prompt or response returned by `list`. Full text stays in the buffer. */
const LIST_TEXT_LIMIT = 600;

function truncate(text: string, limit = LIST_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… ${text.length - limit} more characters (open the call to see all of it)`;
}

/** Rough byte cost of a record, used only to bound the buffer. */
function approximateBytes(record: ModelCallRecord): number {
  let total = (record.system?.length ?? 0) + record.responseText.length + 512;
  for (const message of record.messages) total += message.text.length;
  return total;
}

function textOfMessage(message: { role: string; content: unknown }): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';

  const parts: string[] = [];
  for (const part of message.content as { type?: string; text?: string; toolName?: string; output?: unknown }[]) {
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
    else if (part.type === 'tool-call') parts.push(`[tool-call ${part.toolName ?? '?'}]`);
    else if (part.type === 'tool-result') parts.push(`[tool-result ${part.toolName ?? '?'}]\n${safeJson(part.output)}`);
    else if (part.type === 'file') parts.push('[file]');
    else if (part.type === 'reasoning' && typeof part.text === 'string') parts.push(`[reasoning] ${part.text}`);
  }
  return parts.join('\n');
}

function safeJson(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    // Circular or non-serialisable tool output must not take down the recorder.
    return String(value);
  }
}

export function createModelRecorder(options: CreateModelRecorderOptions = {}): ModelRecorder {
  const capacity = Math.max(1, options.capacity ?? 200);
  const maxBytes = Math.max(64 * 1024, options.maxBytes ?? 8 * 1024 * 1024);
  const classify = options.classify ?? (() => 'unknown' as const);
  const enabled = options.enabled ?? true;

  const buffer: ModelCallRecord[] = [];
  let bufferBytes = 0;
  let evicted = 0;
  let sequence = 0;

  function push(record: ModelCallRecord): void {
    buffer.push(record);
    bufferBytes += approximateBytes(record);

    // Evict oldest-first until both bounds hold. The byte bound is why this is a
    // loop rather than a single shift: one 2 MB analysis prompt can push the
    // buffer over budget on its own.
    while (buffer.length > capacity || (bufferBytes > maxBytes && buffer.length > 1)) {
      const dropped = buffer.shift();
      if (dropped === undefined) break;
      bufferBytes -= approximateBytes(dropped);
      evicted += 1;
    }
  }

  /** Split a provider prompt into the system message and everything else. */
  function readPrompt(prompt: unknown): { system?: string; messages: ModelCallMessage[] } {
    if (!Array.isArray(prompt)) return { messages: [] };

    let system: string | undefined;
    const messages: ModelCallMessage[] = [];

    for (const raw of prompt as { role: string; content: unknown }[]) {
      const text = textOfMessage(raw);
      // Only the FIRST system message becomes `system`. A later one is a real
      // message in the conversation and hiding it would misrepresent the prompt.
      if (raw.role === 'system' && system === undefined) {
        system = text;
        continue;
      }
      messages.push({ role: raw.role as ModelCallMessage['role'], text });
    }

    return system === undefined ? { messages } : { system, messages };
  }

  function middleware(role: ModelCallRole): LanguageModelMiddleware {
    return {
      specificationVersion: 'v4',

      wrapGenerate: async ({ doGenerate, params, model }) => {
        const started = Date.now();
        const base = describeCall(role, 'generate', params, model);
        try {
          const result = await doGenerate();
          const finishReason = readFinishReason(result.finishReason);
          const usage = readUsage(result.usage);
          push(
            finish(base, started, {
              responseText: joinTextContent(result.content),
              toolCalls: summariseToolCalls(result.content),
              ...(finishReason !== undefined ? { finishReason } : {}),
              ...(usage !== undefined ? { usage } : {}),
              warnings: (result.warnings ?? []).map((warning) => safeJson(warning)),
            }),
          );
          return result;
        } catch (error) {
          push(finish(base, started, { error: describeUnknownError(error) }));
          throw error;
        }
      },

      wrapStream: async ({ doStream, params, model }) => {
        const started = Date.now();
        const base = describeCall(role, 'stream', params, model);

        let result: Awaited<ReturnType<typeof doStream>>;
        try {
          result = await doStream();
        } catch (error) {
          // A stream that fails before it opens still produced a prompt worth
          // seeing — arguably the most interesting kind.
          push(finish(base, started, { error: describeUnknownError(error) }));
          throw error;
        }

        const { stream, ...rest } = result;
        let text = '';
        const toolCalls: string[] = [];
        let finishReason: string | undefined;
        let usage: ModelCallRecord['usage'];
        const warnings: string[] = [];

        /*
         * `cancel` is part of the Streams spec and Bun implements it, but
         * TypeScript's `Transformer` type has not caught up — hence the cast.
         * Dropping `cancel` instead would mean a user-cancelled stream is never
         * recorded at all, which loses exactly the calls worth inspecting.
         */
        const transformer = {
          transform(chunk: unknown, controller: TransformStreamDefaultController<unknown>) {
            const part = chunk as {
              type?: string;
              delta?: string;
              finishReason?: unknown;
              usage?: unknown;
              toolName?: string;
              error?: unknown;
            };
            if (part.type === 'text-delta' && typeof part.delta === 'string') text += part.delta;
            else if (part.type === 'tool-call') toolCalls.push(part.toolName ?? '?');
            else if (part.type === 'finish') {
              finishReason = readFinishReason(part.finishReason);
              usage = readUsage(part.usage);
            } else if (part.type === 'error') warnings.push(safeJson(part.error));
            controller.enqueue(chunk);
          },

          // `flush` runs on normal completion. An aborted stream never reaches
          // it, which is correct: the user cancelled, and recording a truncated
          // response as if it finished would be a lie. `cancel` records the
          // partial explicitly instead.
          flush() {
            push(
              finish(base, started, {
                responseText: text,
                toolCalls,
                ...(finishReason !== undefined ? { finishReason } : {}),
                ...(usage !== undefined ? { usage } : {}),
                warnings,
              }),
            );
          },

          cancel() {
            push(
              finish(base, started, {
                responseText: text,
                toolCalls,
                finishReason: 'cancelled',
                ...(usage !== undefined ? { usage } : {}),
                warnings,
              }),
            );
          },
        };

        const recording = new TransformStream<unknown, unknown>(
          transformer as Transformer<unknown, unknown>,
        );

        return { stream: stream.pipeThrough(recording as TransformStream<never, never>), ...rest };
      },
    };
  }

  interface CallBase {
    id: string;
    startedAt: string;
    role: ModelCallRole;
    stage: ModelCallStage;
    operation: 'generate' | 'stream';
    provider: string;
    modelId: string;
    system?: string;
    messages: ModelCallMessage[];
    tools: string[];
    settings: ModelCallRecord['settings'];
    estimatedPromptTokens: number;
  }

  function describeCall(
    role: ModelCallRole,
    operation: 'generate' | 'stream',
    params: unknown,
    model: { provider?: string; modelId?: string },
  ): CallBase {
    const call = params as {
      prompt?: unknown;
      temperature?: number;
      maxOutputTokens?: number;
      responseFormat?: { type?: string };
      tools?: { name?: string }[];
    };
    const { system, messages } = readPrompt(call.prompt);
    sequence += 1;

    const promptText = (system ?? '') + messages.map((message) => message.text).join('\n');

    return {
      id: `${Date.now().toString(36)}-${sequence.toString(36)}`,
      startedAt: new Date().toISOString(),
      role,
      stage: classify(system),
      operation,
      provider: model.provider ?? 'unknown',
      modelId: model.modelId ?? 'unknown',
      ...(system !== undefined ? { system } : {}),
      messages,
      tools: (call.tools ?? []).map((tool) => tool.name ?? '?').filter((name) => name.length > 0),
      settings: {
        ...(typeof call.temperature === 'number' ? { temperature: call.temperature } : {}),
        ...(typeof call.maxOutputTokens === 'number' ? { maxOutputTokens: call.maxOutputTokens } : {}),
        ...(call.responseFormat?.type === 'json' ? { responseFormat: 'json' as const } : {}),
      },
      estimatedPromptTokens: estimateTokens(promptText),
    };
  }

  function finish(
    base: CallBase,
    started: number,
    outcome: {
      responseText?: string;
      toolCalls?: readonly string[];
      finishReason?: string;
      usage?: ModelCallRecord['usage'];
      error?: string;
      warnings?: readonly string[];
    },
  ): ModelCallRecord {
    return {
      ...base,
      responseText: outcome.responseText ?? '',
      toolCalls: outcome.toolCalls ?? [],
      ...(outcome.finishReason !== undefined ? { finishReason: outcome.finishReason } : {}),
      ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
      durationMs: Date.now() - started,
      ok: outcome.error === undefined,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      warnings: outcome.warnings ?? [],
    };
  }

  const disabled: ModelRecorder = {
    wrap: (model) => model,
    list: () => [],
    get: () => undefined,
    stats: () => ({
      total: 0,
      failed: 0,
      byStage: {},
      inputTokens: 0,
      outputTokens: 0,
      totalDurationMs: 0,
      slowestMs: 0,
      bufferBytes: 0,
      capacity,
      evicted: 0,
    }),
    remove: () => false,
    clear: () => 0,
    enabled: false,
  };

  if (!enabled) return disabled;

  log.debug('model recorder active', { capacity, maxBytes });

  return {
    enabled: true,

    wrap: (model, role) => {
      // `LanguageModel` also admits a bare model-id string, which there is no
      // way to wrap: resolving an id needs a provider registry the recorder does
      // not have. Returning it untouched keeps the call working and says so,
      // rather than throwing on a shape the type allows.
      if (typeof model === 'string') {
        log.warn('cannot record a bare model id; pass a model instance to enable recording', { model, role });
        return model;
      }
      return wrapLanguageModel({ model, middleware: middleware(role) });
    },

    list(query = {}) {
      const search = query.search?.trim().toLowerCase();
      const limit = Math.max(1, query.limit ?? 100);

      const matched: ModelCallRecord[] = [];
      // Walk backwards: newest first, and stop as soon as the page is full
      // rather than filtering the whole buffer and slicing.
      for (let index = buffer.length - 1; index >= 0 && matched.length < limit; index -= 1) {
        const record = buffer[index];
        if (record === undefined) continue;
        if (query.stage !== undefined && record.stage !== query.stage) continue;
        if (query.role !== undefined && record.role !== query.role) continue;
        if (query.failedOnly === true && record.ok) continue;
        if (query.failedOnly === false && !record.ok) continue;
        if (
          search !== undefined &&
          search.length > 0 &&
          !(record.system ?? '').toLowerCase().includes(search) &&
          !record.responseText.toLowerCase().includes(search) &&
          !record.messages.some((message) => message.text.toLowerCase().includes(search))
        ) {
          continue;
        }

        matched.push({
          ...record,
          ...(record.system !== undefined ? { system: truncate(record.system) } : {}),
          messages: record.messages.map((message) => ({ ...message, text: truncate(message.text) })),
          responseText: truncate(record.responseText),
        });
      }

      return matched;
    },

    get: (id) => buffer.find((record) => record.id === id),

    stats() {
      const byStage: Record<string, number> = {};
      let failed = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let totalDurationMs = 0;
      let slowestMs = 0;

      for (const record of buffer) {
        byStage[record.stage] = (byStage[record.stage] ?? 0) + 1;
        if (!record.ok) failed += 1;
        inputTokens += record.usage?.inputTokens ?? 0;
        outputTokens += record.usage?.outputTokens ?? 0;
        totalDurationMs += record.durationMs;
        slowestMs = Math.max(slowestMs, record.durationMs);
      }

      return {
        total: buffer.length,
        failed,
        byStage,
        inputTokens,
        outputTokens,
        totalDurationMs,
        slowestMs,
        bufferBytes,
        capacity,
        evicted,
      };
    },

    remove(id) {
      const index = buffer.findIndex((record) => record.id === id);
      if (index === -1) return false;
      const [dropped] = buffer.splice(index, 1);
      // Keep the byte counter in step. Letting it drift would slowly starve the
      // buffer: the byte bound would evict records that are no longer there.
      if (dropped !== undefined) bufferBytes -= approximateBytes(dropped);
      return true;
    },

    clear() {
      const dropped = buffer.length;
      buffer.length = 0;
      bufferBytes = 0;
      evicted = 0;
      return dropped;
    },
  };
}

/* ── content helpers ─────────────────────────────────────────────────────── */

function joinTextContent(content: readonly unknown[]): string {
  return (content as { type?: string; text?: string }[])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('');
}

function summariseToolCalls(content: readonly unknown[]): string[] {
  return (content as { type?: string; toolName?: string; input?: unknown }[])
    .filter((part) => part.type === 'tool-call')
    .map((part) => {
      const input = safeJson(part.input);
      const compact = input.length > 200 ? `${input.slice(0, 200)}…` : input;
      return `${part.toolName ?? '?'}(${compact})`;
    });
}

/**
 * Read a v4 usage object.
 *
 * `LanguageModelV4Usage` nests the counts — `{ inputTokens: { total, noCache,
 * cacheRead, cacheWrite }, outputTokens: { total, text, reasoning } }` — where
 * v2 had flat numbers. Reading it as if it were flat yields `undefined` for
 * everything, which is how the log showed `in=None out=None` beside a call that
 * had plainly consumed tokens. `totalTokens` no longer exists at all, so it is
 * summed here rather than reported as missing.
 */
function readUsage(usage: unknown): ModelCallRecord['usage'] {
  if (usage === null || typeof usage !== 'object') return undefined;

  const numeric = (input: unknown): number | undefined =>
    typeof input === 'number' && Number.isFinite(input) ? input : undefined;

  // Accept the flat v2/v3 shape too: a consumer may pass an older provider, and
  // silently reporting nothing would be worse than handling both.
  const readSlot = (slot: unknown): number | undefined =>
    typeof slot === 'object' && slot !== null ? numeric((slot as { total?: unknown }).total) : numeric(slot);

  const value = usage as { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown };
  const inputTokens = readSlot(value.inputTokens);
  const outputTokens = readSlot(value.outputTokens);
  const totalTokens =
    numeric(value.totalTokens) ??
    (inputTokens === undefined && outputTokens === undefined ? undefined : (inputTokens ?? 0) + (outputTokens ?? 0));

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

/**
 * Read a v4 finish reason.
 *
 * Also an object now — `{ unified, raw }` — so `String(reason)` produced the
 * literal text `[object Object]` in every record. The unified value is the one
 * worth showing; the provider's raw string is appended only when it says
 * something different.
 */
function readFinishReason(reason: unknown): string | undefined {
  if (typeof reason === 'string') return reason;
  if (reason === null || typeof reason !== 'object') return undefined;

  const value = reason as { unified?: unknown; raw?: unknown };
  const unified = typeof value.unified === 'string' ? value.unified : undefined;
  const raw = typeof value.raw === 'string' ? value.raw : undefined;

  if (unified === undefined) return raw;
  return raw === undefined || raw === unified ? unified : `${unified} (${raw})`;
}
