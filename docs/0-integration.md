# A→Z: integrating LocalMind, feeding it data, and what it does with it

This document is the operational counterpart to the four stage documents. It
covers the whole path: how to embed LocalMind in an existing project, how to get
your data in, what happens to that data mechanically, what comes out, and what
happens when any of it fails.

---

## 0. The one mental model

Everything is built around a single interface:

```ts
interface Retriever {
  search(query: string, options?: RetrievalOptions): Promise<readonly RetrievedChunk[]>;
  listSources(): Promise<readonly { title: string; relativePath: string; chunkCount: number }[]>;
  close(): Promise<void>;
}
```

**Stage 1 produces a `Retriever`. Stages 2, 3 and 4 are three different
strategies for consuming one.** They do not know about each other, and they never
touch LanceDB, Ollama, or OpenRouter directly.

That is why the pieces compose freely: you can take Stage 2's grounded generation
and point it at your own retriever, or take Stage 4's grading node and drop it
into your own pipeline. There is no god object and no framework runtime.

```
your data ──► ingest ──► LanceDB + manifest ──► Retriever ──┬──► Stage 2  ask
                                                            ├──► Stage 3  agent
                                                            └──► Stage 4  research
```

---

## 1. Integration

There are three integration modes, in increasing order of involvement.

### Mode A — as a CLI / sidecar (no code)

Drop `.md` or `.txt` files into `corpus/`, then:

```bash
bun run ingest
bun run ask "…" > answer.md          # stdout is pure answer text
```

Diagnostics go to **stderr**, answers to **stdout**. That separation is
deliberate and is what makes the CLIs pipeable from another process. With
`LOCALMIND_LOG=json` the trace becomes one JSON object per line, so a supervising
service can parse it.

Exit codes: `0` success, `1` fatal (with the error code, a remedy, and the cause
printed to stderr). `bun run doctor` exits non-zero on a blocking
misconfiguration, which makes it usable as a container healthcheck or a CI gate.

### Mode B — as a library inside your app

Nothing here is CLI-coupled. The whole of Stage 2 in a request handler:

```ts
import { loadConfig } from './src/core/config';
import { createModelRegistry } from './src/core/providers';
import { openRetriever } from './src/retrieval/retriever';
import { streamGroundedAnswer } from './src/generation/grounded-answer';

const config = loadConfig();                       // parses + validates env once
const registry = createModelRegistry(config);      // no I/O, cheap
const retriever = await openRetriever({ config, embeddingModel: registry.embedding });

// per request
const chunks = await retriever.search(question, { topK: 6, minScore: 0.25 });
const streamed = streamGroundedAnswer({
  model: registry.chat,
  question,
  chunks,
  maxContextTokens: config.retrieval.maxContextTokens,
  signal: request.signal,                          // client disconnect cancels the model call
});

for await (const delta of streamed.textStream) response.write(delta);
const { citations, audit, abstained } = await streamed.settled();
```

Lifecycle notes that matter in a server:

- `loadConfig()` and `createModelRegistry()` are startup-time work. Do them once.
- `openRetriever()` opens the LanceDB table and reads the manifest. Open it once
  and share it; it is safe for concurrent reads.
- `retriever.close()` on shutdown.
- **LanceDB is a single-writer store.** Concurrent *reads* are fine; run
  ingestion as a separate job, not inside a request handler, and do not run two
  ingests against one table at the same time.
- `config` is a plain frozen-ish object, so per-tenant overrides are a spread:
  `{ ...config, store: { ...config.store, tableName: `t_${tenantId}` } }`.

Swapping in Stage 3 or Stage 4 is a different import, same retriever:

```ts
import { runRetrievalAgent } from './src/agent/retrieval-agent';
import { runSelfCorrectingWorkflow } from './src/workflow/graph';
import { createWebSearchProvider } from './src/workflow/web-search';
```

### Mode C — your own data source (the common real case)

Your knowledge is almost certainly not markdown files. `createSourceDocument()`
is the seam: it applies exactly the same normalisation and hashing as the file
loader, so chunk ids stay deterministic and re-ingestion stays idempotent for
custom sources too.

```ts
import { createSourceDocument } from './src/ingest/loader';
import { ingestCorpus } from './src/ingest/pipeline';

const rows = await db.query('select id, title, body from kb_articles');

const documents = rows.map((row) =>
  createSourceDocument({
    id: `article-${row.id}`,                        // stable, unique, yours
    title: row.title,
    text: row.body,
    sourcePath: `postgres://kb/articles/${row.id}`, // what appears in citations
  }),
);

const report = await ingestCorpus({ config, registry, documents, prune: true });
```

Verified working — that exact shape produces:

```
0.626  postgres://kb/articles/77  "# Shipping SLA\n\nStandard shipping is 5-7 business days. Expr…"
0.513  postgres://kb/articles/42  "# Refund window\n\nRefunds are accepted within 30 days of deli…"
```

Rules for custom sources:

| Field | Requirement | Why |
|---|---|---|
| `id` | stable across runs, unique | chunk ids derive from it; a changed id orphans old rows, a duplicate id silently overwrites (`assertUniqueDocumentIds` catches the latter) |
| `sourcePath` | human-actionable | it is what a reader sees in a citation — a URL or `table/pk` beats `row 3` |
| `text` | plain text or markdown | markdown headings become the retrieval breadcrumb, so structure is a real quality win |

**What is not built in:** PDF, DOCX and HTML extraction. Convert upstream
(`pdf-parse`, `turndown`, Apache Tika) and hand the text to
`createSourceDocument`. That boundary is deliberate — document extraction is a
large problem with no good general answer, and burying a mediocre one inside the
loader would be worse than requiring you to choose.

---

## 2. Feeding the data: what actually happens to a document

Real numbers from the demo corpus, so you can sanity-check your own run.

### 2.1 Load — `src/ingest/loader.ts`

```
corpus/ → 5 files, 16,401 chars
```

Per file: strip BOM → CRLF/CR → LF → trim trailing whitespace per line →
collapse runs of 4+ newlines → trim. **Then** hash.

Normalising before hashing is the point: without it the same file checked out on
Windows and Linux produces different hashes, so every chunk id changes and
re-ingestion duplicates your corpus.

Then: `id` = slugified relative path, `title` = first `# H1` (falling back to the
first short line, then the path), `contentHash` = sha256 of the normalised text.
Unreadable, oversized (>2 M chars) and empty files are **skipped with a warning**;
a corpus with zero usable documents throws `CORPUS_EMPTY`.

### 2.2 Chunk — `src/ingest/chunker.ts`

```
5 documents → 20 chunks, mean 254 tokens (min 149, max 355)
```

At `LOCALMIND_CHUNK_CHARS=1200`, `LOCALMIND_CHUNK_OVERLAP=180`:

1. **Index headings.** Every ATX heading with its character offset.
2. **Atomise.** Recursively split on the most semantic separator that applies —
   `\n## ` → `\n### ` → `\n#### ` → `\n\n` → `\n- ` → `\n` → `. ` → ` ` — until
   every piece fits 1200 chars. Separators stay at the *start* of the following
   piece, which keeps a heading glued to its section. A hard character slice is
   the last resort and is only reached by content with no whitespace at all.
3. **Pack.** Greedily merge atoms into the largest windows that still fit. A
   trailing runt under 64 chars is folded into its predecessor.
4. **Overlap.** Extend each window's start back by 180 chars, snapped to a word
   boundary, floored at `previousStart + 1` — that floor is the termination
   guarantee: starts strictly increase, so the splitter cannot loop.

Each chunk carries:

```ts
{
  id: sha256(`${documentId}:${index}:${documentContentHash}`).slice(0, 32),
  charStart, charEnd,        // re-slice the original document exactly
  headingPath: 'Overlap',    // breadcrumb, H1 excluded (it duplicates the title)
  text:      '…verbatim slice…',                       // what a human reads
  embedText: 'Chunking Strategies > Overlap\n\n…slice…' // what gets embedded
}
```

The `text`/`embedText` split is the single highest-value trick in the stage. A
chunk saying *"the recommended overlap is 10 to 20 percent"* is ambiguous alone;
the breadcrumb restores the subject for the retriever without polluting the
quotation.

### 2.3 Embed — `src/ingest/embedder.ts`

One probe call establishes dimensionality (`nomic-embed-text` → **768**), because
the Arrow schema needs an exact width before the first row is written. Then
`embedMany` in batches of 64.

Every vector is validated before it is allowed near the index:

- wrong width → `EMBEDDING_DIMENSION_MISMATCH`
- any non-finite value → `EMBEDDING_FAILED` (usually a truncated model download)
- all-zero → `EMBEDDING_FAILED` (cosine similarity is undefined; the row would
  come back for *every* query with distance NaN or 1)
- provider returned N ≠ input count → throw, because embeddings are matched to
  chunks **by position** and a length mismatch is unrecoverable

### 2.4 Store — `src/store/vector-store.ts`

```
20 rows into .data/lancedb/chunks.lance   →   5.4s end to end
```

An explicit Arrow schema, never inference: `vector` is
`FixedSizeList(768, Float32 nullable-child)`, plus 11 metadata columns with
declared widths and nullability. Inference can produce a variable-length `List`
(which cannot be vector-indexed, so search silently degrades to a brute-force
scan) or a `Float64` `chunkIndex` (after which `WHERE chunkIndex = 3` matches
nothing).

Writes use `mergeInsert('id').whenMatchedUpdateAll().whenNotMatchedInsertAll()`.
Combined with the deterministic chunk id this makes re-ingestion **idempotent** —
verified: running `bun run ingest` twice leaves 20 rows, not 40.

### 2.5 Manifest — `src/store/manifest.ts`

Written **last**, after every row has landed:

```json
{ "manifestVersion": 1, "embeddingProvider": "ollama", "embeddingModel": "nomic-embed-text",
  "dimensions": 768, "chunking": { "maxChars": 1200, "overlapChars": 180 },
  "documentCount": 5, "chunkCount": 20, "createdAt": "…", "updatedAt": "…" }
```

Two jobs. **Crash safety:** a missing manifest unambiguously means "this index is
unfinished", and because upsert is idempotent the fix is to re-run. **The
guard:** every read path compares `(provider, model)` against the running config
first. Mismatched *widths* LanceDB would catch anyway; matching widths with a
*different model* is the case only the manifest catches, and it is the one that
matters, because nothing errors — the query vector just lands in an unrelated
region of a different vector space and retrieval returns confident nonsense.

### 2.6 When you must rebuild

| Change | Action |
|---|---|
| Added / edited / removed documents | `bun run ingest` (add `--prune` to drop deleted ones) |
| `LOCALMIND_EMBEDDING_MODEL` or provider | `bun run ingest --rebuild` — **required** |
| `LOCALMIND_CHUNK_CHARS` / `_OVERLAP` | `bun run ingest --rebuild` — chunk ids change, so old rows orphan |
| `topK`, `minScore`, context budget, chat model | nothing; query-time only |

---

## 3. The working: what each stage does per request

### Query path, common to all stages

```
question ──► embed (raw, no breadcrumb prefix)
         ──► LanceDB cosine search, over-fetching max(topK*3, topK+4) = 18 for topK=6
         ──► score = clamp(1 - _distance, 0, 1); rows with non-finite distance skipped
         ──► keep score >= minScore (0.25), take topK
```

Over-fetching then thresholding in application code is deliberate: asking
LanceDB for exactly `topK` and hoping they clear the bar lets one strong chunk
crowd out the rest of the budget.

The query is embedded **raw** while chunks were embedded **with** the breadcrumb.
That asymmetry is intentional — the prefix moves chunks toward the topic region
where topical queries already live. If you switch to a model that wants explicit
`search_query:` / `search_document:` prefixes (E5, BGE, some Nomic variants), add
them in *both* places and rebuild; mixing prefixed and unprefixed vectors in one
table is silent quality loss.

### Stage 2 — Ground · 1 embed + 1 chat call

`assembleContext` → dedupe by id → merge adjacent chunks from the same document
(stitching away the overlap seam so one claim cannot look doubly-sourced) → rank
by score → spend the 3000-token budget best-first, truncating a partial fit only
if ≥40% survives, otherwise dropping it and recording the id → label `S1…Sn` →
render as `<source id="S1" title="…" relevance="0.806">…</source>`.

Then one `streamText` with the grounding contract as `instructions`. Then a
deterministic citation audit.

Observed:

```
6 passages, top 0.806 → 3 blocks, 1311/3000 tokens → 1807 in / 285 out, 9.6s
```

### Stage 3 — Delegate · ≤ maxSteps chat calls, ≤ 6 embeds

`ToolLoopAgent` with `searchKnowledgeBase`, `listKnowledgeSources`,
`finalAnswer`. The model chooses queries; the trace assigns run-stable `S#`
labels and enforces the loop guards.

Observed on a compound question — the thing Stage 2 cannot do:

```
step 1  searchKnowledgeBase  "chunk overlap"     4 hits, top 0.700
step 2  searchKnowledgeBase  "distance metric"   4 hits, top 0.605
step 3  (text)
→ 3/8 steps, 2 searches, 10-passage evidence pool, 7321 in / 764 out, 10.9s
```

### Stage 4 — Verify · ~9 model calls for a simple question

```
plan(1) → per sub-query [ retrieve(1 embed) + grade(1) ] × attempts
        → rewrite(1) per failed attempt
        → web fallback if still insufficient
        → generate(1) → verify(1) → [ repair(1) → verify(1) ]
```

Worst case is `maxSubQueries × (1 + maxRewrites)` retrievals +
`1 + maxRepairs` generations — 9 and 2 at the defaults. `assertBudgetSane()`
rejects a configuration exceeding 24 retrievals or 4 generations **before any
model call**, so a bad `.env` fails in milliseconds.

Observed, with the repair loop firing:

```
plan        1 sub-query
retrieve    6 passages, top 0.806
grade       relevant=1 partial=2 irrelevant=3  → sufficient
generate    2 sources, 758 context tokens
verify      not grounded — 2 factual sentences carry no citation
repair      regenerating
verify      repaired answer is grounded
done        verified · 9 model calls · 2805 in / 1187 out
```

Point `LOCALMIND_GRADER_MODEL` at something cheap: plan, grade, rewrite and
verify are four of those calls and none needs a frontier model.

---

## 4. The output

### stdout / stderr contract

| Stream | Content |
|---|---|
| **stdout** | the answer text, nothing else |
| **stderr** | banner, trace, sources table, reports, warnings, fatal errors |

### Return shapes

**Stage 2** — `GroundedAnswerResult`

```ts
{
  answer: string,
  citations: Citation[],            // label, chunkId, title, relativePath, headingPath, score, origin
  context: { blocks, tokensUsed, tokenBudget, droppedChunkIds, degraded },
  audit:   { used, unknown, unused, uncitedSentences, ok },
  abstained: boolean,               // answer begins with INSUFFICIENT_CONTEXT
  usage: { inputTokens, outputTokens },
  finishReason: string,
}
```

**Stage 3** — `AgentRunResult` adds `confidence`
(`high|medium|low|insufficient|unknown`), `evidence`, `searches[]` (each with
`repeated` / `budgetExhausted` flags), `steps`, and `stopReason`
(`final-answer-tool | model-emitted-text | step-limit | fallback-synthesis`).

**Stage 4** — `WorkflowResult` adds `plan`, `subQueries[]` (per-attempt grade
counts), `webResults`, `repaired`, `events[]` (the phase trace), and:

```ts
verification: {
  grounded: boolean,      // did every claim check out
  confident: boolean,     // could verification actually run — false ⇒ "unverified", not "wrong"
  tier: 'deterministic' | 'semantic' | 'unavailable',
  unsupportedClaims: [{ claim, citedLabel, problem }],
  reason: string,
}
```

**Read `grounded` and `confident` together.** `grounded: false, confident: false`
means the verifier was unavailable, not that the answer is wrong.

### The three answer classes

1. **Grounded answer** — prose with `[S#]` on every factual sentence.
2. **Abstention** — begins with the literal token `INSUFFICIENT_CONTEXT:`
   followed by the specific missing fact. Machine-checkable on purpose:
   `isAbstention()` is a branch a caller can act on, which is how Stage 4
   decides to fall back to the web.
3. **Partial** — answers what it can, then a final line beginning
   `Not in sources:`.

---

## 5. Failure handling and recovery

The design rule is one sentence: **fail open where a false negative destroys
information, fail closed where a false positive destroys trust.**

### 5.1 The typed error surface

Every fatal path raises a `LocalMindError` carrying a `code`, a `message`, a
**`remedy`**, structured `details`, and the original `cause`. Every CLI funnels
through `reportFatal`, so the operator experience is identical everywhere:

```
x INDEX_MANIFEST_MISMATCH  The index was built with a different embedding configuration
                           (model: index=nomic-embed-text config=mxbai-embed-large).
  -> Either restore the original embedding settings, or rebuild the index:
     `bun run ingest --rebuild`. Querying across two vector spaces returns
     semantically random results without erroring.
```

Codes: `CONFIG_INVALID`, `PROVIDER_UNAVAILABLE`, `CORPUS_EMPTY`,
`CORPUS_UNREADABLE`, `CHUNKING_FAILED`, `EMBEDDING_FAILED`,
`EMBEDDING_DIMENSION_MISMATCH`, `VECTOR_STORE_FAILED`, `INDEX_MISSING`,
`INDEX_MANIFEST_MISMATCH`, `CONTEXT_BUDGET_EXCEEDED`, `MODEL_CALL_FAILED`,
`STRUCTURED_OUTPUT_INVALID`, `AGENT_LOOP_EXHAUSTED`, `AGENT_LOOP_STALLED`,
`WEB_SEARCH_FAILED`.

### 5.2 Fail-fast: caught before any work happens

- **Config** — Zod parse plus cross-field checks. `overlap >= chunkChars` is
  rejected (it makes the splitter emit the same window forever); a provider set
  to `openrouter` without a key is rejected.
- **Budget** — `assertBudgetSane()` before the first model call.
- **Dimensions** — a wrong-width query vector is rejected in `search()` before it
  reaches the index.
- **Manifest** — compared on every read path.
- **`bun run doctor`** — daemon reachable, model actually pulled, OpenRouter slug
  present in the catalogue *and* advertising `tools` + `structured_outputs`,
  corpus readable, index compatible, and one real embedding call. Non-zero exit
  on anything blocking.

### 5.3 Transient failures: retry

`withRetry` wraps every model call: 3 attempts, exponential backoff with jitter
(±30%), each retry logged with the attempt number and the error. Applied to
`embedMany` per batch (retrying 64 chunks is cheap; retrying 20,000 is not),
`embed`, and generation.

### 5.4 Malformed model output: `safeGenerateObject`

Stage 4 makes several structured calls per question. At that volume, "the model
emitted prose instead of JSON" is a design constraint, not an edge case. So
`safeGenerateObject` **never throws** — it returns a result type, and logs the
raw text from `NoObjectGeneratedError`, which is the single most useful artifact
when a grader misbehaves.

Each node then encodes its own policy:

| Node | Policy | On failure | Rationale |
|---|---|---|---|
| **plan** | fail **open** | use the raw question as the only sub-query | degrades to exactly Stage 2 behaviour — never worse than having no planner |
| **grade** | fail **open** | assume `partial`, keep the passage | a flaky grader must never be able to silently delete correct evidence |
| **rewrite** | **terminal** | stop rewriting | retrying a rewriter that just failed on the same input is a spin |
| **verify** | fail **closed** | `grounded: false, confident: false` | an unverified answer must never be presented as verified |

This is not theoretical. A live run:

```
warn  resilience     retrying after failure  label=plan attempt=1 delayMs=333
warn  workflow:plan  planner failed; using the raw question as the only sub-query
info  workflow:graph [plan] planner degraded; using the raw question
… pipeline continued, answer produced, verification passed
```

### 5.5 Runaway loops: four independent brakes (Stage 3)

1. `hasToolCall('finalAnswer')` — the intended, model-chosen exit.
2. `isStepCount(maxSteps)` — the cost backstop.
3. **Pressure before the limit.** `prepareStep` sets
   `activeTools: ['finalAnswer']` once the retrieval budget is spent or the step
   limit is near. Telling a model to stop searching is a suggestion; removing the
   tool is a guarantee.
4. **Repeat detection.** A query that normalises to one already run does *not*
   re-search; it returns a steering message listing what was tried. Cheaper than
   a search and strictly more informative than a second empty result.

Plus a per-call token budget (900, max 320 per excerpt) on tool results, because
those are re-sent on every subsequent step — six 300-token passages over four
steps is ~7k tokens of duplicated evidence, which on an 8k-context model silently
evicts the instructions.

### 5.6 Graceful degradation: the ladder

Nothing fails outright while a weaker correct answer is still available.

| Failure | Degradation |
|---|---|
| Agent loop ends with no committed answer | synthesise from the evidence pool via Stage 2 → `stopReason: 'fallback-synthesis'` |
| Agent retrieved nothing at all | `AGENT_LOOP_EXHAUSTED`, remedy: try `bun run ask` to isolate whether the model emits valid tool calls |
| Planner unavailable | raw question as the single sub-query (Stage 2 behaviour) |
| Grader unavailable | keep everything as `partial` |
| Local corpus insufficient | rewrite, then web fallback |
| Web search unavailable or empty | abstain — losing the fallback costs coverage, never correctness |
| Verifier unavailable | return the answer flagged `confident: false` and skip repair (another generation cannot fix an unmeasured problem) |
| Context over budget | drop lowest-scoring passages, report `degraded: true` and the dropped ids |
| Zero passages above threshold | deterministic abstention **with no model call** — the correct output is known, and asking a model for it only invites it to answer from memory |

### 5.7 Recovery mechanics

- **Interrupted ingest** — re-run it. Deterministic chunk ids + merge-insert mean
  you only pay for the work that was lost, and the manifest is written last so an
  unfinished index is detectable rather than silently half-built.
- **Corrupt or stale table** — `bun run ingest --rebuild` drops and recreates it.
  `.data/` is disposable by design.
- **Deleted source documents** — `--prune` deletes rows whose `documentId` is no
  longer in the source set. Without it, deleted content stays retrievable.
- **Ctrl-C** — `SIGINT` aborts an `AbortController` whose signal is threaded into
  every model call and every node, so in-flight requests cancel rather than
  orphan. In a server, pass `request.signal` the same way.
- **Bad answer** — run `bun run search` with the same query first. If the right
  passage is not in that list, the problem is chunking or embedding, not
  prompting. This ordering saves the most time of anything in the repo.

### 5.8 What is not defended against

Stated plainly, because knowing the edges is part of using it:

- **Node.** The library targets Bun and uses Bun APIs directly; it does not run
  on Node as written. `src/core/fs.ts` is the single place those calls live, and
  it documents which `node:` imports remain and why.
- **Concurrent writers.** LanceDB is single-writer. Two simultaneous ingests
  against one table will conflict. Reads are safe and concurrent — and a table
  rebuilt underneath a live handle is now recovered from via `checkoutLatest()`
  rather than failing.
- **No auth, tenancy, or rate limiting.** Per-tenant isolation is a `tableName`
  override; enforcement is your app's job.
- **`pruneDocuments` builds a `NOT IN (…)` list of every kept id.** Fine for
  thousands of documents; batch it past that.
- **Brute-force vector scan.** No ANN index is built. Correct and fast to about
  100k rows; past that, add one (`table.createIndex`).
- **Single-turn only.** No conversation history, so *"what about the other one?"*
  is unembeddable. Multi-turn needs history-aware query rewriting plus
  `pruneMessages`.
- **No document extraction.** Text in, text out; convert PDF/HTML upstream.
- **Token counts are estimates**, deliberately over-approximating. Budget maths
  is only used to decide how much context to drop, and over-estimating fails safe.
