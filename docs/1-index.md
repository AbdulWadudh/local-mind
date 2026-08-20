# Stage 1 — Index

**Capability gained:** a local corpus becomes semantically searchable.
**No model generation yet.** By the end of this stage you can ask a question in
natural language and get back the passages that answer it, ranked, with scores.

```bash
bun run ingest
bun run search "why is cosine better than euclidean for text"
```

---

## 1. The problem this layer solves

A language model cannot read your files. The entire purpose of this stage is to
build a lookup table from *meaning* to *passage*, so that later stages can put
the right 3000 tokens in front of the model instead of the wrong 3000 tokens.

Everything that goes wrong downstream is usually traceable to here. If the
passage containing the answer never makes it into the top-k, no prompt
engineering in Stage 2 can recover it, no reformulation in Stage 3 can find it,
and no verification in Stage 4 can do anything except correctly report that the
answer is unsupported. This is why `bun run search` exists as a separate command:
when an answer is wrong, run the query through retrieval alone first. If the
right passage is not in the list, stop debugging prompts.

The pipeline is five steps, and the ordering is load-bearing:

```
load  →  chunk  →  probe dimensions  →  embed  →  upsert  →  write manifest
```

Dimensions are probed **before** the table is opened, because the Arrow schema
needs an exact vector width. The manifest is written **last**, after every row
has landed, so a missing manifest unambiguously means "this index is unfinished".

## 2. Files added

```
src/core/
  ansi.ts            terminal styling built from String.fromCharCode(27)
  config.ts          Zod-validated env → LocalMindConfig; the only reader of process.env
  errors.ts          LocalMindError: a code, a message, and a remedy
  logger.ts          structured logging to stderr (human or JSON)
  providers.ts       createProviderRegistry → provider-agnostic model handles
  resilience.ts      withRetry, safeGenerateObject (used from Stage 4)
  tokens.ts          tokenizer-free estimation and budget-safe truncation
  types.ts           SourceDocument, Chunk, RetrievedChunk, IndexManifest, Retriever
src/ingest/
  loader.ts          walk, normalise, hash, derive titles and ids
  chunker.ts         recursive separator descent + overlap + heading breadcrumbs
  embedder.ts        batched embedMany with vector validation
  pipeline.ts        the orchestration above
src/store/
  vector-store.ts    explicit Arrow schema, cosine search, merge-insert upsert
  manifest.ts        the guard against querying across two vector spaces
src/retrieval/
  retriever.ts       the Retriever interface every later stage consumes
src/cli/
  shared.ts          argv parsing, banner, SIGINT → AbortSignal, error UX
  doctor.ts          preflight diagnostics
  ingest.ts          bun run ingest
  search.ts          bun run search
```

## 3. Pitfalls, and what defends against each

### 3.1 Chunk boundary loss — the expensive one

A fixed-width splitter produces two distinct failures. Sentence severance is the
obvious one. **Subject detachment** is the damaging one: a chunk reading *"the
default is 60 seconds"* has lost the noun it describes. No user query resembles
that text, so it is effectively unretrievable — and if it *is* retrieved, the
model cannot tell what defaults to 60 seconds.

Three mitigations, all in `src/ingest/chunker.ts`:

1. **Recursive separator descent.** Split on the most semantic boundary that
   works — `\n## ` → `\n### ` → `\n\n` → `\n` → `. ` → ` ` — and fall back to a
   hard character slice only for content with no whitespace at all. Separators
   are kept at the *start* of the following piece, which is what keeps a heading
   glued to the section it introduces.

2. **Overlap, with a termination guarantee.** Each chunk re-includes the
   trailing `overlapChars` of its predecessor, snapped to a word boundary. The
   guarantee matters: the overlap start is floored at `previousStart + 1`, so
   chunk starts strictly increase and the splitter cannot loop. `overlap >=
   maxChars` is rejected outright at config load — that configuration emits the
   same window forever.

3. **Contextual chunk headers.** `Chunk.embedText` is
   `"{title} > {headingPath}\n\n{text}"`; `Chunk.text` is the verbatim slice.
   The breadcrumb moves the vector toward the topic region of the space, where
   topical queries already live, while quotations stay exact.

The harness asserts all three: offsets re-slice to the chunk text, consecutive
chunk ranges overlap, starts strictly increase, and `embedText` contains the
breadcrumb while `text` does not.

### 3.2 Two vector spaces in one table — the silent one

You ingest with `nomic-embed-text` (768-dim), later switch to a different 768-dim
model, and query. **Nothing errors.** The query vector lands in an unrelated
region of a different space, retrieval returns plausible-looking chunks that are
semantically random, and Stage 2 dutifully grounds a confident answer in them.

`src/store/manifest.ts` writes `{provider, model, dimensions, chunking}` next to
the table and compares it before every read. Turning a silent quality collapse
into a loud, actionable failure is the entire value of that 200-byte file.
Mismatched *widths* would be caught by LanceDB anyway; matching widths with a
different model is the case only the manifest catches.

### 3.3 Schema inference

LanceDB will infer a schema from your first batch. Don't let it:

- A `number[]` may be inferred as a variable-length `List` rather than
  `FixedSizeList`. A `List` column cannot carry a vector index, so search
  silently degrades to a brute-force scan — or fails when you later add an index.
- `chunkIndex` may land as `Float64`, after which `WHERE chunkIndex = 3` matches
  nothing.

`buildChunkSchema()` declares every field explicitly. Note that the
`FixedSizeList` child field must be **nullable** — Arrow's canonical form has it
nullable, and a non-nullable child makes schema comparison fail on reopen.

### 3.4 L2 by default

LanceDB defaults to L2. Text embedding models are trained with cosine
objectives and their outputs are not consistently unit-normalised, so L2
conflates "different topic" with "longer passage". Every query here sets
`.distanceType('cosine')` explicitly. LanceDB returns
`_distance = 1 - cosineSimilarity`, so `score = 1 - distance`, clamped to `[0,1]`.

### 3.5 Duplicate corpora on re-ingest

Appending on every run doubles the index. `upsert` uses
`mergeInsert('id').whenMatchedUpdateAll().whenNotMatchedInsertAll()`, and the id
is `sha256(documentId : chunkIndex : documentContentHash).slice(0, 32)`.
Unchanged content therefore produces the same key, which makes re-ingestion
idempotent *and* makes an interrupted ingest safe to simply re-run. Verified:
running `bun run ingest` twice leaves 20 rows, not 40.

### 3.6 Poisoned vectors

Three input classes that a vector database will happily store and then
mis-rank forever, all rejected in `embedder.ts`:

- **Wrong width** — one model must produce every vector in a table.
- **NaN / Infinity** — usually a truncated model download.
- **All-zero** — cosine similarity is undefined; the row comes back for *every*
  query with distance NaN or 1. `search()` additionally skips any row whose
  `_distance` is non-finite, because one such row outranking real evidence is
  worse than losing it.

### 3.7 Over-fetch, then threshold

`retriever.search()` asks LanceDB for `max(topK * 3, topK + 4)` candidates and
applies `minScore` in application code. Asking for exactly `topK` and hoping they
clear the bar lets a single high-scoring chunk crowd out the rest of the budget.

## 4. Design notes worth stealing

**`Retriever` is an interface, not a class.** Stage 2 calls it, Stage 3 wraps it
in a `tool()`, Stage 4 calls it per planned sub-query, and the harness replaces it
wholesale. That one indirection is why the test suite can exercise the full agent
loop with no model server.

**Tokenizer-free accounting.** `estimateTokens` takes the max of `chars/4` and
`words*1.35` because they under-count in opposite directions. It deliberately
over-estimates: budget maths is only ever used to decide how much context to
*drop*, and over-estimating fails safe.

**Errors carry remedies.** Every `LocalMindError` has a `remedy` string printed by
every CLI. `INDEX_MANIFEST_MISMATCH` does not just say what is wrong, it says
`bun run ingest --rebuild` and explains that querying across two vector spaces
returns semantically random results.

## 5. Validation

```bash
bun run verify       # 43 hermetic tests; ~30 of them are Stage 1
```

The hermetic tier uses a **signed feature-hashing embedding model**
(`src/testing/hashing-embedding.ts`) against a real LanceDB table in a temp
directory. That is deliberate: a random-vector fake would prove the plumbing
works while telling you nothing about ranking, so an assertion like *"the cosine
passage ranks first"* would be meaningless. Feature hashing is a real, if
primitive, lexical vector space — documents sharing vocabulary genuinely land
near each other — so cosine distance, score conversion, thresholding and ordering
are all exercised for real, deterministically, with no network.

Observed live on the demo corpus with `nomic-embed-text`:

```
5 documents, 16,401 chars → 20 chunks (mean 254 tok, min 149, max 355) → 768-dim, 5.4s

$ bun run search "why is cosine better than euclidean for text" --top-k 3
#1  0.772  Embedding Models and Vector Spaces > The vector space is not portable
#2  0.699  Embedding Models and Vector Spaces > Cosine similarity versus Euclidean distance
#3  0.573  LanceDB as an Embedded Vector Store > Declare the schema explicitly
```

Note that the query contains "euclidean", which appears in the corpus only as a
heading — the 0.772 top hit is semantic, not lexical. That is the whole point of
the stage.

## 6. What Stage 1 cannot do

It returns passages, not answers. And it searches for *exactly* what you typed,
once. Ask a compound question and you get one averaged embedding that matches
neither half. That limitation is what Stage 3 exists to fix; first,
[Stage 2](2-ground.md) has to make the model answer *only* from what came back.
