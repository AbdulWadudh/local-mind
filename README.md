# LocalMind

A local-first Agentic RAG **library** built from first principles on the
**Vercel AI SDK 7** and **LanceDB**, in strict TypeScript on **Bun** — with no
agent framework anywhere in the stack.

Install it, point it at a GitHub repo and the services that repo actually uses,
and ask questions that are answered with citations you can check.

```bash
bun add localmind
```

> **Runtime: Bun.** The library uses Bun APIs directly — `Bun.file`, `Bun.write`,
> `Bun.spawn`, `Bun.CryptoHasher`, `import.meta.dir` — rather than their Node
> equivalents, and `node:` is imported only where Bun has no equivalent
> (`node:path`, `os.tmpdir`, `mkdtemp`, `readdir` with directory entries; see
> `src/core/fs.ts` for the full list and the reason for each). That is a
> deliberate trade: the code is simpler and faster on Bun, and it does not run on
> Node as written.

```ts
import { LocalMind } from 'localmind';
import { githubSource, postgresSource } from 'localmind/sources';

const mind = await LocalMind.open();
await mind.ingestSource(githubSource({ repo: 'your-org/orders-api' }));
await mind.ingestSource(postgresSource({ url: process.env.DATABASE_URL! }));

const { answer, verification } = await mind.research('where is refund state stored?');
```

There is also a UI — **Studio** — that you mount into any app:

```ts
import { createStudioRouter } from 'localmind/studio';
Bun.serve({ port: 3000, fetch: createStudioRouter().fetch });
```

It is organised as four incremental stages. Each one adds capability to a single
evolving codebase; none of them rewrites the last.

| Stage | Name | Capability gained | Run it |
|---|---|---|---|
| 1 | **Index** | Chunk, embed, store, search a local corpus | `bun run ingest` → `bun run search "…"` |
| 2 | **Ground** | Cited, streamed answers that abstain instead of guessing | `bun run ask "…"` |
| 3 | **Delegate** | The model decides *when* and *what* to retrieve | `bun run agent "…"` |
| 4 | **Verify** | Plan → grade → self-correct → web fallback → verify | `bun run research "…"` |

Read [0 Integration](docs/0-integration.md) for the operational picture and
[5 Studio & Sources](docs/5-studio-and-sources.md) for the UI, the GitHub
analyzer and the nine service connectors.

Read the stage documents in order: [1 Index](docs/1-index.md) ·
[2 Ground](docs/2-ground.md) · [3 Delegate](docs/3-delegate.md) ·
[4 Verify](docs/4-verify.md). Each explains the problem the layer solves, the
pitfalls it defends against, and which files it added.

Each stage document explains the problem that layer solves, the pitfalls it
defends against, and which files it added.

---

## Quick start

```bash
bun install

# Fully local path (no API keys). Requires Ollama.
ollama serve                       # in another terminal
ollama pull nomic-embed-text       # 768-dim embeddings, ~275 MB
ollama pull llama3.1:8b            # tool-capable chat model, ~4.9 GB

bun run doctor                     # preflight: providers, models, corpus, index
bun run verify                     # 43 hermetic tests, no network, no models
bun run ingest                     # build the index
bun run search "cosine distance"   # Stage 1
bun run ask     "why is cosine preferred over L2 for text embeddings?"
bun run agent   "what chunk overlap should I use and which distance metric?"
bun run research "how does the kubernetes HPA decide to scale down?"
```

### Zero-install chat models via OpenRouter

Embeddings stay local; generation goes through the free router.

```bash
echo 'LOCALMIND_CHAT_PROVIDER=openrouter' >> .env
echo 'OPENROUTER_API_KEY=sk-or-v1-…'      >> .env
```

That is the whole setup. The default slug is `openrouter/free`, the auto-router:
no model research, no allow-list to go stale as free tiers rotate, and nothing to
404 when a provider retires a slug.

**What the router costs.** It picks a random free model per request, so two
identical runs can be served by two different models and quality varies run to
run. A real observed response to a grounded-answer prompt was the single line
`User Safety: safe` — nothing errored, the answer was just garbage.

**Why the pipeline survives it.** Every defensive layer here exists for this
class of model, and the router is the honest test of them:

| Layer | What a bad router model does instead of breaking the run |
| --- | --- |
| `safeGenerateObject` | Returns a `Result`, so unparseable JSON degrades one node |
| `plan` / `grade` fail **open** | A nonsense plan costs a planning step, not the answer |
| `verify` fails **closed** | An unreadable verdict is never reported as "grounded" |
| `normaliseCitationMarkers` | Accepts `【S1】`, `［S1］`, `[S1, S2]` — punctuation variance stops being a groundedness failure |
| `withRetry` | Re-rolls, and since routing is per-request the retry is usually a *different* model |

Pin a slug when you want a fixed baseline for measurement:

```bash
echo 'LOCALMIND_CHAT_MODEL=nvidia/nemotron-3-super-120b-a12b:free' >> .env
```

That one is free, has 262k context, and was verified to emit well-formed tool
calls and schema-valid structured output, which Stages 3 and 4 require. Other
verified free options: `openai/gpt-oss-20b:free`,
`google/gemma-4-26b-a4b-it:free`.

---

## Architecture

Source is organised by **domain**, not by stage. Stage number is a property of
the curriculum, not of the code; a `milestone-03/` directory that
`milestone-04/` has to import from is archaeology, not architecture.

```
src/
  core/            config, provider resolution, errors, logging, tokens, resilience
  ingest/          loader, chunker, embedder, pipeline           ← Stage 1
  store/           chunk table, document table, index manifest   ← Stage 1
  retrieval/       retriever, context assembly, citation audit    ← Stages 1-2
  generation/      grounding contract, grounded answer             ← Stage 2
  agent/           retrieval tools, trace, tool-loop agent         ← Stage 3
  workflow/        plan / grade / rewrite / verify nodes, graph     ← Stage 4
  corpus/          the write side: document CRUD + re-embedding
  sources/         github analyzer + 9 service connectors
  studio/          mountable Hono router + wire protocol
  testing/         hashing embedding model, assertion harness
  cli/             per-stage entrypoints, doctor, verify, studio
  localmind.ts     the public facade
studio/            the Vite + React 19 Studio client
corpus/            the demo knowledge base (five markdown documents)
docs/              integration guide, one document per stage, studio & sources
```

Data flows one way, and every stage consumes the stage below it through an
interface rather than a concrete type:

```
corpus/*.md
   │  loader        normalise, hash, derive title
   │  chunker       recursive split + overlap + heading breadcrumb
   │  embedder      batched embedMany, vector validation
   ▼
LanceDB table (fixed-size Float32 vector + metadata) ── manifest.json
   │  retriever     embed query, cosine search, threshold      ← Retriever iface
   ├──────────────────────────────► Stage 2  assemble context → grounded answer
   ├──────────────────────────────► Stage 3  tool({ … })      → ToolLoopAgent
   └──────────────────────────────► Stage 4  plan/grade/rewrite/verify graph
```

## What is deliberately absent

- **No agent framework.** Control flow is `tool()`, `stopWhen`, `prepareStep`,
  `ToolLoopAgent`, and ordinary `if`/`for`. Nothing else.
- **No cloud dependency for storage.** LanceDB is a directory. `.data/` is
  gitignored and disposable.
- **No tokenizer dependency.** Token accounting deliberately over-estimates, so
  budget errors fail safe (send less) rather than loud (provider 400 mid-stream).
- **No `process.env` outside `core/config.ts`.** Which is what lets the test
  harness construct a config by hand and run the pipeline deterministically.

## Commands

| Command | What it does |
|---|---|
| `bun run doctor` | Preflight: daemon reachable, models pulled, corpus readable, index compatible, one real embedding call. Exits non-zero on a blocking issue. |
| `bun run verify` | 43 hermetic tests — no network, no model server, no key. Real LanceDB, deterministic hashing embeddings. |
| `bun run verify --live` | Adds four model-dependent smoke tests across Stages 2–4. |
| `bun run ingest [--rebuild] [--prune]` | Build the index. `--rebuild` after changing the embedding model or chunk size. |
| `bun run search "…" [--top-k N] [--min-score F] [--where SQL] [--full]` | Retrieval only. **The first thing to run when an answer looks wrong.** |
| `bun run ask "…" [--no-stream]` | Stage 2: grounded, streamed, cited. |
| `bun run agent "…" [--max-steps N]` | Stage 3: agentic retrieval with a step trace. |
| `bun run research "…" [--max-rewrites N] [--max-repairs N]` | Stage 4: the full self-correcting workflow with a phase trace. |
| `bun run studio` | Serve the Studio UI + API on :4141. |
| `bun run studio:dev` | Vite HMR on :5273, proxying `/api` to :4141. |
| `bun run typecheck:all` | `tsc --noEmit` for the library and the Studio client. |
| `bun run build` | JS bundles, `.d.ts` with rewritten extensions, and the SPA. |

Diagnostics go to **stderr**, answers to **stdout**, so
`bun run ask "…" > answer.md` yields a clean file while the trace stays on
screen. `LOCALMIND_LOG=json` switches to one JSON object per line;
`LOCALMIND_LOG_LEVEL=debug` adds per-batch detail.

## Configuration

Every value has a working default — an empty `.env` runs fully local against
Ollama. See [`.env.example`](.env.example) for the annotated list. The knobs that
actually change behaviour:

| Variable | Default | Effect |
|---|---|---|
| `LOCALMIND_CHAT_PROVIDER` | `ollama` | `ollama` or `openrouter` |
| `LOCALMIND_EMBEDDING_MODEL` | `nomic-embed-text` | Changing this **requires** `--rebuild` |
| `LOCALMIND_CHUNK_CHARS` / `_OVERLAP` | `1200` / `180` | Chunk geometry; also requires `--rebuild` |
| `LOCALMIND_TOP_K` / `_MIN_SCORE` | `6` / `0.25` | Retrieval breadth and the abstention threshold |
| `LOCALMIND_MAX_CONTEXT_TOKENS` | `3000` | Hard budget for assembled context |
| `LOCALMIND_MAX_AGENT_STEPS` | `8` | Stage 3 loop ceiling |
| `LOCALMIND_WEB_SEARCH` | `offline` | `offline` fixtures, `ollama`, or `openrouter` `:online` |

## Reading order for the code

If you want to understand the system rather than run it, read in this order —
each file's header comment explains *why* it exists, not just what it does:

1. `src/ingest/chunker.ts` — the three mitigations for chunk boundary loss
2. `src/store/vector-store.ts` — why the Arrow schema is explicit and cosine is not the default
3. `src/store/manifest.ts` — the silent failure that costs the most to debug
4. `src/retrieval/context.ts` — lost-in-the-middle, overlap duplication, budget overflow
5. `src/generation/prompt.ts` — the four rules that carry the grounding contract
6. `src/agent/tools.ts` — the three failure modes that tool-calling introduces
7. `src/workflow/graph.ts` — why Stage 4 takes control flow *back* from the model

## Stack

| Concern | Choice | Version |
|---|---|---|
| Runtime | Bun | 1.3+ |
| Orchestration | `ai` (Vercel AI SDK) | 7.x |
| Chat providers | `ai-sdk-ollama`, `@openrouter/ai-sdk-provider` | 4.x / 3.x |
| Vector store | `@lancedb/lancedb` | 0.37.x |
| Arrow | `apache-arrow` | 18.x (LanceDB peer range is `>=15 <=18.1`) |
| Schemas | `zod` | 4.x |

AI SDK 7 renamed several primitives. If you are porting older code:
`system:` → `instructions:`, `stepCountIs` → `isStepCount`, `Agent` →
`ToolLoopAgent`, `parameters` → `inputSchema`, and top-level result fields now
accumulate across steps (`result.finalStep.*` for last-step-only).

One trap worth knowing, documented at length in `src/core/providers.ts`:
`createProviderRegistry` resolves models via `provider.languageModel(id)`, and
for `@openrouter/ai-sdk-provider` that overload returns the **legacy completion
model** on the older provider spec. Everything appears to work while silently
running through a compatibility shim. Resolve chat models with an explicit
`.chat()` instead.
