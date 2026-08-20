import { join, normalize, resolve, sep } from 'node:path';

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import { LocalMindError, describeUnknownError } from '../core/errors';
import { inspectPath, readBytes } from '../core/fs';
import { createLogger } from '../core/logger';
import { LocalMind } from '../localmind';
import { CONNECTORS, createSource, githubSource } from '../sources';
import type { DetectedService } from '../sources/types';

import type {
  AnalyzePreview,
  AnalyzeRequest,
  ChatEvent,
  ChatRequest,
  CorpusDocumentSummary,
  CorpusListResponse,
  CorpusUpsertRequest,
  HealthResponse,
  ModelCallListResponse,
  ModelCallStage,
  ProjectListResponse,
  IngestRequest,
  SearchRequest,
  SourceEvent,
  TraceEvent,
} from './protocol';

/**
 * The Studio API, as a mountable Hono router.
 *
 * WHY HONO, AND WHY MOUNTABLE
 * The requirement was a library you install, not an application you clone. A
 * Hono app is a plain `fetch` handler, so this router mounts under an existing
 * app with `app.route('/admin/mind', createStudioRouter())` and needs no
 * framework of its own.
 *
 * RUNTIME: BUN. The static handler uses `Bun.file` and `import.meta.dir`, so
 * this is not portable to Node or Workers as written. That is a deliberate
 * project-wide choice (see `core/fs.ts`); `hono/bun` is still avoided because
 * hand-rolling the handler is what lets the path-traversal guard and the
 * cache-control policy live here, where they can be read.
 *
 * WHY SSE RATHER THAN WEBSOCKETS
 * Every long operation here is one-directional server→client progress: token
 * deltas, workflow phases, clone progress. SSE gives that over plain HTTP with
 * automatic reconnect and no protocol upgrade, which matters when the router is
 * mounted behind someone else's proxy.
 */

const log = createLogger('studio');

export interface StudioRouterOptions {
  /**
   * An already-open instance. Supply one in a server that also uses LocalMind
   * elsewhere, so both share a single set of LanceDB handles.
   */
  readonly mind?: LocalMind;
  /** Options forwarded to `LocalMind.open()` when `mind` is not supplied. */
  readonly open?: Parameters<typeof LocalMind.open>[0];
  /** Directory holding the built SPA. Defaults to the bundled `client/`. */
  readonly clientDir?: string;
  /** Serve the SPA. Set false to expose the JSON/SSE API only. */
  readonly serveClient?: boolean;
  /** Path prefix the API lives under, relative to the mount point. */
  readonly apiPrefix?: string;
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function defaultClientDir(): string {
  // `import.meta.dir` is Bun's equivalent of
  // `dirname(fileURLToPath(import.meta.url))`. Resolving from this module's own
  // location makes it work from `src/` in development and `dist/` after a build.
  return join(import.meta.dir, 'client');
}

function extensionOf(path: string): string {
  const index = path.lastIndexOf('.');
  return index === -1 ? '' : path.slice(index).toLowerCase();
}

/** Serialise a LocalMindError (or anything) into the shape the UI expects. */
function errorPayload(error: unknown): { code: string; message: string; remedy: string } {
  if (LocalMindError.is(error)) {
    return { code: error.code, message: error.message, remedy: error.remedy };
  }
  return {
    code: 'UNEXPECTED',
    message: describeUnknownError(error),
    remedy: 'Check the server logs for a stack trace.',
  };
}

const MODEL_CALL_STAGES: readonly ModelCallStage[] = [
  'ground',
  'agent',
  'plan',
  'grade',
  'rewrite',
  'verify',
  'analyze',
  'unknown',
];

function isStage(value: string | undefined): value is ModelCallStage {
  return value !== undefined && (MODEL_CALL_STAGES as readonly string[]).includes(value);
}

export function createStudioRouter(options: StudioRouterOptions = {}) {
  const apiPrefix = options.apiPrefix ?? '/api';
  const clientDir = resolve(options.clientDir ?? defaultClientDir());
  const serveClient = options.serveClient ?? true;

  // Opened lazily and shared: `LocalMind.open()` touches the filesystem and
  // probes the embedding model, so doing it per request would be absurd. A
  // single in-flight promise also collapses a burst of concurrent first
  // requests into one open.
  let pending: Promise<LocalMind> | undefined;
  const getMind = (): Promise<LocalMind> => {
    if (options.mind !== undefined) return Promise.resolve(options.mind);
    pending ??= LocalMind.open(options.open ?? {});
    return pending;
  };

  const app = new Hono();
  const api = new Hono();

  /* ── health ────────────────────────────────────────────────────────────── */

  api.get('/health', async (context) => {
    try {
      const mind = await getMind();
      const stats = await mind.corpus.stats();

      const body: HealthResponse = {
        ok: true,
        models: {
          chat: `${mind.config.chat.provider}/${mind.config.chat.model}`,
          grader: `${mind.config.chat.provider}/${mind.config.chat.graderModel}`,
          embedding: `${mind.config.embedding.provider}/${mind.config.embedding.model}`,
        },
        store: { dbPath: mind.config.store.dbPath, tableName: mind.config.store.tableName },
        retrieval: {
          topK: mind.config.retrieval.topK,
          minScore: mind.config.retrieval.minScore,
          maxContextTokens: mind.config.retrieval.maxContextTokens,
        },
        webSearch: mind.webSearch.describe,
        corpus: {
          documents: stats.documents,
          chunks: stats.chunks,
          dimensions: stats.dimensions,
          embeddingModel: stats.embeddingModel,
          byOrigin: stats.byOrigin,
        },
        connectors: CONNECTORS,
      };

      return context.json(body);
    } catch (error) {
      log.error('health failed', errorPayload(error));
      return context.json({ ok: false, ...errorPayload(error) }, 500);
    }
  });

  /* ── corpus CRUD ───────────────────────────────────────────────────────── */

  api.get('/corpus', async (context) => {
    const mind = await getMind();
    const search = context.req.query('search');
    const origin = context.req.query('origin');
    const limit = Number(context.req.query('limit') ?? '200');

    const documents = await mind.corpus.list({
      ...(search !== undefined && search.length > 0 ? { search } : {}),
      ...(origin !== undefined && origin.length > 0 ? { origin: origin as CorpusDocumentSummary['origin'] } : {}),
      limit: Number.isFinite(limit) ? limit : 200,
    });
    const stats = await mind.corpus.stats();

    const body: CorpusListResponse = {
      // Summaries only: the list view does not need document bodies, and a
      // corpus of 500 repository documents would otherwise be a 20 MB response.
      documents: documents.map((document) => ({
        id: document.id,
        title: document.title,
        sourcePath: document.sourcePath,
        origin: document.origin,
        tags: document.tags,
        sourceRef: document.sourceRef,
        chunkCount: document.chunkCount,
        charCount: document.text.length,
        updatedAt: document.updatedAt,
      })),
      total: documents.length,
      stats: {
        documents: stats.documents,
        chunks: stats.chunks,
        dimensions: stats.dimensions,
        embeddingModel: stats.embeddingModel,
        byOrigin: stats.byOrigin,
      },
    };

    return context.json(body);
  });

  api.get('/corpus/:id', async (context) => {
    const mind = await getMind();
    const document = await mind.corpus.get(context.req.param('id'));
    if (document === undefined) return context.json({ error: 'not found' }, 404);
    return context.json(document);
  });

  api.post('/corpus', async (context) => {
    try {
      const mind = await getMind();
      const body = (await context.req.json()) as CorpusUpsertRequest;
      if (typeof body.title !== 'string' || typeof body.text !== 'string') {
        return context.json({ error: 'title and text are required' }, 400);
      }
      const result = await mind.putDocument({
        ...(body.id !== undefined ? { id: body.id } : {}),
        title: body.title,
        text: body.text,
        ...(body.sourcePath !== undefined ? { sourcePath: body.sourcePath } : {}),
        ...(body.tags !== undefined ? { tags: body.tags } : {}),
        origin: body.origin ?? 'manual',
      });
      return context.json(result);
    } catch (error) {
      return context.json(errorPayload(error), 400);
    }
  });

  api.put('/corpus/:id', async (context) => {
    try {
      const mind = await getMind();
      const body = (await context.req.json()) as CorpusUpsertRequest;
      const result = await mind.putDocument({
        id: context.req.param('id'),
        title: body.title,
        text: body.text,
        ...(body.sourcePath !== undefined ? { sourcePath: body.sourcePath } : {}),
        ...(body.tags !== undefined ? { tags: body.tags } : {}),
        ...(body.origin !== undefined ? { origin: body.origin } : {}),
      });
      return context.json(result);
    } catch (error) {
      return context.json(errorPayload(error), 400);
    }
  });

  api.delete('/corpus/:id', async (context) => {
    const mind = await getMind();
    const result = await mind.removeDocument(context.req.param('id'));
    return context.json(result);
  });

  api.delete('/sources/:ref', async (context) => {
    const mind = await getMind();
    const result = await mind.corpus.removeBySourceRef(decodeURIComponent(context.req.param('ref')));
    return context.json(result);
  });

  api.post('/corpus/reindex', async (context) =>
    streamSSE(context, async (stream) => {
      const mind = await getMind();
      try {
        const result = await mind.corpus.reindex((done, total) => {
          void stream.writeSSE({ data: JSON.stringify({ type: 'progress', stage: 'reindex', done, total }) });
        });
        await stream.writeSSE({ data: JSON.stringify({ type: 'ingested', summary: result }) });
      } catch (error) {
        await stream.writeSSE({ data: JSON.stringify({ type: 'error', ...errorPayload(error) }) });
      }
    }),
  );

  /* ── search ────────────────────────────────────────────────────────────── */

  api.post('/search', async (context) => {
    try {
      const mind = await getMind();
      const body = (await context.req.json()) as SearchRequest;
      const startedAt = Date.now();
      const results = await mind.search(body.query, {
        ...(body.topK !== undefined ? { topK: body.topK } : {}),
        ...(body.minScore !== undefined ? { minScore: body.minScore } : {}),
        ...(body.sourceRef !== undefined && body.sourceRef.length > 0 ? { sourceRef: body.sourceRef } : {}),
      });
      return context.json({ results, durationMs: Date.now() - startedAt });
    } catch (error) {
      return context.json(errorPayload(error), 400);
    }
  });

  /* ── connectors ────────────────────────────────────────────────────────── */

  api.get('/connectors', (context) => context.json({ connectors: CONNECTORS }));

  /* ── inspect: recorded model calls ─────────────────────────────────────── */

  api.get('/calls', async (context) => {
    try {
      const mind = await getMind();
      const stage = context.req.query('stage');
      const role = context.req.query('role');
      const status = context.req.query('status');
      const search = context.req.query('search');
      const limit = Number(context.req.query('limit') ?? '100');

      const body: ModelCallListResponse = {
        calls: mind.recorder.list({
          // Validated against the union rather than cast into it: an unknown
          // `?stage=` is a client bug, and silently forwarding it would filter
          // every record out and look like "no calls recorded".
          ...(isStage(stage) ? { stage } : {}),
          ...(role === 'chat' || role === 'grader' ? { role } : {}),
          // `status` is tri-state on the wire: absent means "either".
          ...(status === 'failed' ? { failedOnly: true } : status === 'ok' ? { failedOnly: false } : {}),
          ...(search !== undefined && search.length > 0 ? { search } : {}),
          limit: Number.isFinite(limit) ? limit : 100,
        }),
        stats: mind.recorder.stats(),
        enabled: mind.recorder.enabled,
      };

      return context.json(body);
    } catch (error) {
      log.error('calls failed', errorPayload(error));
      return context.json(errorPayload(error), 500);
    }
  });

  api.get('/calls/:id', async (context) => {
    const mind = await getMind();
    const record = mind.recorder.get(context.req.param('id'));
    // A 404 here is expected, not exceptional: the buffer is a ring, and a call
    // the user left open long enough will have been evicted by newer ones.
    if (record === undefined) {
      return context.json(
        {
          code: 'NOT_FOUND',
          message: 'That call is no longer buffered.',
          remedy: 'The log keeps the most recent calls only; older ones are evicted as new ones arrive.',
        },
        404,
      );
    }
    return context.json(record);
  });

  api.delete('/calls', async (context) => {
    const mind = await getMind();
    return context.json({ cleared: mind.recorder.clear() });
  });

  api.delete('/calls/:id', async (context) => {
    const mind = await getMind();
    const removed = mind.recorder.remove(context.req.param('id'));
    // 200 either way: the buffer is a ring, so a record the user deletes may
    // already have been evicted. That is the requested end state, not an error.
    return context.json({ removed });
  });

  /* ── projects: the distinct ingested sources ───────────────────────────── */

  api.get('/projects', async (context) => {
    try {
      const mind = await getMind();
      const body: ProjectListResponse = { projects: await mind.listProjects() };
      return context.json(body);
    } catch (error) {
      log.error('projects failed', errorPayload(error));
      return context.json(errorPayload(error), 500);
    }
  });

  /* ── repository analysis (dry run) ─────────────────────────────────────── */

  api.post('/sources/analyze', async (context) => {
    const body = (await context.req.json()) as AnalyzeRequest;

    return streamSSE(context, async (stream) => {
      const send = async (event: SourceEvent): Promise<void> => {
        await stream.writeSSE({ data: JSON.stringify(event) });
      };

      try {
        const mind = await getMind();
        const source = githubSource({
          ...(body.repo !== undefined ? { repo: body.repo } : {}),
          ...(body.path !== undefined ? { path: body.path } : {}),
          ...(body.ref !== undefined ? { ref: body.ref } : {}),
          ...(body.token !== undefined ? { token: body.token } : {}),
          ...(body.skipSynthesis === true ? { skipSynthesis: true } : {}),
        });

        // Deliberately does NOT write to the corpus. The user gets to see what
        // was found, and which services were detected, before committing to an
        // ingest that will replace whatever the previous run produced.
        const collected = await source.collect({
          chatModel: mind.registry.chat,
          onProgress: (progress) => {
            void send({
              type: 'progress',
              stage: progress.stage,
              ...(progress.detail !== undefined ? { detail: progress.detail } : {}),
              ...(progress.done !== undefined ? { done: progress.done } : {}),
              ...(progress.total !== undefined ? { total: progress.total } : {}),
            });
          },
        });

        const preview: AnalyzePreview = {
          sourceRef: source.ref,
          label: source.label,
          documents: collected.documents.map((document) => ({
            id: document.id ?? document.title,
            title: document.title,
            charCount: document.text.length,
          })),
          detectedServices: collected.detectedServices,
          warnings: collected.warnings,
          stats: collected.stats,
        };

        await send({ type: 'preview', preview });
      } catch (error) {
        log.error('analyze failed', errorPayload(error));
        await send({ type: 'error', ...errorPayload(error) });
      }
    });
  });

  /* ── ingest any source ─────────────────────────────────────────────────── */

  api.post('/sources/ingest', async (context) => {
    const body = (await context.req.json()) as IngestRequest;

    return streamSSE(context, async (stream) => {
      const send = async (event: SourceEvent): Promise<void> => {
        await stream.writeSSE({ data: JSON.stringify(event) });
      };

      try {
        const mind = await getMind();
        const source = createSource(body.kind, body.config ?? {});

        const summary = await mind.ingestSource(source, {
          ...(Array.isArray(body.include) && body.include.length > 0 ? { include: body.include } : {}),
          onProgress: (progress) => {
            void send({
              type: 'progress',
              stage: progress.stage,
              ...(progress.detail !== undefined ? { detail: progress.detail } : {}),
              ...(progress.done !== undefined ? { done: progress.done } : {}),
              ...(progress.total !== undefined ? { total: progress.total } : {}),
            });
          },
        });

        await send({ type: 'ingested', summary });
      } catch (error) {
        log.error('ingest failed', errorPayload(error));
        await send({ type: 'error', ...errorPayload(error) });
      }
    });
  });

  /* ── chat: the three answering modes ──────────────────────────────────── */

  api.post('/chat', async (context) => {
    const body = (await context.req.json()) as ChatRequest;

    return streamSSE(context, async (stream) => {
      const send = async (event: ChatEvent): Promise<void> => {
        await stream.writeSSE({ data: JSON.stringify(event) });
      };
      const trace = async (event: TraceEvent): Promise<void> => send({ type: 'trace', event });

      const startedAt = Date.now();

      try {
        const mind = await getMind();
        const question = (body.question ?? '').trim();
        if (question.length === 0) {
          await send({ type: 'error', code: 'CONFIG_INVALID', message: 'Empty question.', remedy: 'Type a question.' });
          return;
        }

        // Shared by all three modes on purpose. `mind.#scoped()` reads
        // `sourceRef` from exactly this object, so a mode cannot be added later
        // that quietly answers from outside the scope the user selected.
        const askOptions = {
          ...(body.topK !== undefined ? { topK: body.topK } : {}),
          ...(body.minScore !== undefined ? { minScore: body.minScore } : {}),
          ...(body.sourceRef !== undefined && body.sourceRef.length > 0 ? { sourceRef: body.sourceRef } : {}),
        };

        if (body.mode === 'ask') {
          await trace({ kind: 'retrieve', label: 'Retrieving passages' });
          const streamed = await mind.ask(question, askOptions);

          await send({
            type: 'sources',
            citations: streamed.citations.map((citation) => {
              const block = streamed.context.blocks.find((entry) => entry.label === citation.label);
              return { ...citation, ...(block !== undefined ? { excerpt: block.text } : {}) };
            }),
          });
          await trace({
            kind: 'generate',
            label: `Answering from ${streamed.citations.length} source(s)`,
            detail: `${streamed.context.tokensUsed}/${streamed.context.tokenBudget} context tokens`,
          });

          for await (const delta of streamed.textStream) await send({ type: 'delta', text: delta });

          const settled = await streamed.settled();
          await send({
            type: 'done',
            mode: 'ask',
            answer: settled.answer,
            audit: settled.audit,
            abstained: settled.abstained,
            usage: settled.usage,
            durationMs: Date.now() - startedAt,
          });
          return;
        }

        if (body.mode === 'agent') {
          const result = await mind.agent(question, {
            ...askOptions,
            onStep: ({ step, toolCalls, text }) => {
              void trace({
                kind: 'step',
                label: `Step ${step}`,
                detail: toolCalls.length > 0 ? toolCalls.join(', ') : text.slice(0, 60) || 'no tool calls',
                tone: toolCalls.length > 0 ? 'neutral' : 'warn',
              });
            },
          });

          await send({
            type: 'sources',
            citations: result.citations.map((citation) => {
              const chunk = result.evidence.find((entry) => entry.id === citation.chunkId);
              return { ...citation, ...(chunk !== undefined ? { excerpt: chunk.text } : {}) };
            }),
          });

          for (const search of result.searches) {
            await trace({
              kind: 'retrieve',
              label: search.repeated ? 'Repeated query blocked' : `Searched "${search.query}"`,
              detail: `${search.resultCount} hit(s), top ${search.topScore.toFixed(3)}`,
              tone: search.repeated ? 'warn' : search.resultCount === 0 ? 'warn' : 'good',
            });
          }

          await send({
            type: 'done',
            mode: 'agent',
            answer: result.answer,
            audit: result.audit,
            abstained: result.confidence === 'insufficient',
            usage: result.usage,
            durationMs: result.durationMs,
            stopReason: result.stopReason,
            confidence: result.confidence,
          });
          return;
        }

        // research
        const result = await mind.research(question, {
          ...askOptions,
          onEvent: (event) => {
            const tone: TraceEvent['tone'] =
              event.phase === 'done' ? 'good' : event.phase === 'repair' || event.phase === 'rewrite' ? 'warn' : 'neutral';
            void trace({
              kind: event.phase === 'web-search' ? 'web' : (event.phase as TraceEvent['kind']),
              label: event.message,
              tone,
            });
          },
        });

        await send({ type: 'sources', citations: result.citations });
        await send({
          type: 'done',
          mode: 'research',
          answer: result.answer,
          audit: result.verification.audit,
          abstained: result.abstained,
          usage: result.usage,
          durationMs: result.durationMs,
          verification: result.verification,
          subQueries: result.subQueries,
          repaired: result.repaired,
          phases: [...new Set(result.events.map((event) => event.phase))],
        });
      } catch (error) {
        log.error('chat failed', errorPayload(error));
        await send({ type: 'error', ...errorPayload(error) });
      }
    });
  });

  app.route(apiPrefix, api);

  /* ── static SPA ────────────────────────────────────────────────────────── */

  if (serveClient) {
    app.get('/*', async (context) => {
      const url = new URL(context.req.url);
      // Strip the mount prefix so the router works mounted at any path.
      const mountPrefix = context.req.path.slice(0, context.req.path.length - (url.pathname.length - 1));
      void mountPrefix;

      const requested = decodeURIComponent(url.pathname).replace(/^\/+/u, '');
      const candidate = requested.length === 0 ? 'index.html' : requested;

      // Path traversal guard: resolve, then verify the result is still inside
      // clientDir. Checking for ".." in the input is not sufficient.
      const target = resolve(clientDir, normalize(candidate));
      const inside = target === clientDir || target.startsWith(clientDir + sep);

      const send = async (path: string): Promise<Response> => {
        const body = await readBytes(path);
        const extension = extensionOf(path);
        return new Response(body, {
          headers: {
            'content-type': MIME_TYPES[extension] ?? 'application/octet-stream',
            // Vite emits content-hashed asset filenames, so those are immutable;
            // index.html must never be cached or deploys do not take effect.
            'cache-control': extension === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
          },
        });
      };

      if (inside) {
        const info = await inspectPath(target);
        if (info.isFile) return await send(target);
      }

      // SPA fallback: unknown paths are client-side routes.
      try {
        return await send(join(clientDir, 'index.html'));
      } catch {
        return context.json(
          {
            error: 'Studio UI assets not found',
            remedy: `Build the client (\`bun run studio:build\`) or pass \`clientDir\`. Looked in ${clientDir}.`,
          },
          503,
        );
      }
    });
  }

  return app;
}

/** Convenience for `Bun.serve` / `Deno.serve`: `{ fetch, port }`. */
export function createStudioServer(options: StudioRouterOptions & { readonly port?: number } = {}) {
  const app = createStudioRouter(options);
  return { fetch: app.fetch, port: options.port ?? 4141 };
}

export type { DetectedService };
export type * from './protocol';
