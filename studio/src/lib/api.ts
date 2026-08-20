import type {
  AnalyzeRequest,
  ChatEvent,
  ChatRequest,
  CorpusListResponse,
  CorpusUpsertRequest,
  CorpusUpsertResponse,
  HealthResponse,
  IngestRequest,
  ModelCallListResponse,
  ModelCallRecord,
  ProjectListResponse,
  SearchRequest,
  SearchResponse,
  SourceEvent,
} from '@localmind/protocol';
import type { CorpusDocument } from '@localmind/protocol';

/**
 * The typed API client.
 *
 * Two things worth noting.
 *
 * 1. Every event shape comes from the library's own `protocol.ts` via the
 *    `@localmind/protocol` alias. The UI cannot drift from the server.
 *
 * 2. SSE here is read with `fetch` + a manual parser rather than
 *    `EventSource`. `EventSource` cannot issue a POST, and every streaming
 *    endpoint in this API needs a request body. The parser below is the whole
 *    cost of that decision: ~20 lines, and it also gives us AbortSignal support,
 *    which `EventSource` lacks.
 */

const BASE = '/api';

export class ApiError extends Error {
  readonly code: string;
  readonly remedy: string;

  constructor(input: { code: string; message: string; remedy: string }) {
    super(input.message);
    this.name = 'ApiError';
    this.code = input.code;
    this.remedy = input.remedy;
  }
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });

  if (!response.ok) {
    let payload: { code?: string; message?: string; error?: string; remedy?: string } = {};
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      // Non-JSON error body (a proxy error page, usually).
    }
    throw new ApiError({
      code: payload.code ?? `HTTP_${response.status}`,
      message: payload.message ?? payload.error ?? response.statusText,
      remedy: payload.remedy ?? 'Check the server logs.',
    });
  }

  return (await response.json()) as T;
}

/**
 * Read a `data:`-only SSE stream, yielding each parsed event.
 *
 * The server sends one JSON object per event and no event names, so the parser
 * only has to handle `data:` lines and blank-line frame separators. Multi-line
 * `data:` is still joined correctly, because a JSON payload containing a newline
 * would otherwise silently truncate.
 */
async function* readSse<T>(path: string, body: unknown, signal?: AbortSignal): AsyncGenerator<T> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal !== undefined ? { signal } : {}),
  });

  if (!response.ok || response.body === null) {
    throw new ApiError({
      code: `HTTP_${response.status}`,
      message: `Stream failed: ${response.statusText}`,
      remedy: 'Check that the API process is running.',
    });
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');

        if (data.length > 0) {
          try {
            yield JSON.parse(data) as T;
          } catch {
            // A malformed frame must not kill the stream; the next one may be fine.
          }
        }

        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export const api = {
  health: (): Promise<HealthResponse> => json<HealthResponse>('/health'),

  projects: (): Promise<ProjectListResponse> => json<ProjectListResponse>('/projects'),

  calls: {
    list: (
      params: { stage?: string; role?: string; status?: string; search?: string; limit?: number } = {},
    ): Promise<ModelCallListResponse> => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && String(value).length > 0) query.set(key, String(value));
      }
      const suffix = query.toString();
      return json<ModelCallListResponse>(`/calls${suffix.length > 0 ? `?${suffix}` : ''}`);
    },

    get: (id: string): Promise<ModelCallRecord> => json<ModelCallRecord>(`/calls/${encodeURIComponent(id)}`),

    remove: (id: string): Promise<{ removed: boolean }> =>
      json(`/calls/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    clear: (): Promise<{ cleared: number }> => json('/calls', { method: 'DELETE' }),
  },

  corpus: {
    list: (params: { search?: string; origin?: string; limit?: number } = {}): Promise<CorpusListResponse> => {
      const query = new URLSearchParams();
      if (params.search !== undefined && params.search.length > 0) query.set('search', params.search);
      if (params.origin !== undefined && params.origin.length > 0) query.set('origin', params.origin);
      if (params.limit !== undefined) query.set('limit', String(params.limit));
      const suffix = query.toString();
      return json<CorpusListResponse>(`/corpus${suffix.length > 0 ? `?${suffix}` : ''}`);
    },

    get: (id: string): Promise<CorpusDocument> => json<CorpusDocument>(`/corpus/${encodeURIComponent(id)}`),

    create: (body: CorpusUpsertRequest): Promise<CorpusUpsertResponse> =>
      json<CorpusUpsertResponse>('/corpus', { method: 'POST', body: JSON.stringify(body) }),

    update: (id: string, body: CorpusUpsertRequest): Promise<CorpusUpsertResponse> =>
      json<CorpusUpsertResponse>(`/corpus/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),

    remove: (id: string): Promise<{ removed: boolean; chunksRemoved: number }> =>
      json(`/corpus/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    removeSource: (ref: string): Promise<{ documents: number; chunksRemoved: number }> =>
      json(`/sources/${encodeURIComponent(ref)}`, { method: 'DELETE' }),

    reindex: (signal?: AbortSignal): AsyncGenerator<SourceEvent> =>
      readSse<SourceEvent>('/corpus/reindex', {}, signal),
  },

  search: (body: SearchRequest): Promise<SearchResponse> =>
    json<SearchResponse>('/search', { method: 'POST', body: JSON.stringify(body) }),

  chat: (body: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> =>
    readSse<ChatEvent>('/chat', body, signal),

  analyzeRepo: (body: AnalyzeRequest, signal?: AbortSignal): AsyncGenerator<SourceEvent> =>
    readSse<SourceEvent>('/sources/analyze', body, signal),

  ingestSource: (body: IngestRequest, signal?: AbortSignal): AsyncGenerator<SourceEvent> =>
    readSse<SourceEvent>('/sources/ingest', body, signal),
};

export type {
  HealthResponse,
  CorpusListResponse,
  ChatEvent,
  SourceEvent,
  ProjectListResponse,
  ModelCallListResponse,
};
