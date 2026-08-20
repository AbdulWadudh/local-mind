# Stage 4 — Verify

**Capability gained:** guarantees. Every question is planned, every retrieved
passage is graded, failed retrievals are self-corrected, gaps fall back to the
web, and no answer is presented as verified unless it was.

```bash
bun run research "why is cosine preferred over L2 for text embeddings?"
bun run research "how does the kubernetes HPA decide to scale down?"   # triggers the fallback
```

---

## 1. The problem this layer solves

Stage 3 works, and you cannot prove anything about it. You cannot guarantee the
model graded its retrieval, or verified its answer, because those are
instructions and instructions are advisory.

Stage 4 takes the control flow back. The model is still doing the work that needs
language understanding — planning, grading, rewriting, generating, verifying —
but *when* each of those happens is ordinary TypeScript. Consequences:

- Every transition is a line in a trace you can read.
- Every loop has a numeric bound, so worst-case cost is computable **before** you
  run it.
- The same question follows the same path every time.

This is not "better than Stage 3". It is a different trade: flexibility for
auditability. Open-ended exploration wants Stage 3; anything with a correctness
requirement wants Stage 4.

## 2. The pipeline

```
PLAN                       decompose into sub-queries
  │
  ├── for each sub-query:
  │     RETRIEVE  ──►  GRADE
  │       ▲              │
  │       │  insufficient & rewrites left
  │       └── REWRITE ───┤
  │                      │  insufficient & rewrites spent
  │                      └── WEB SEARCH (fallback)
  │
GENERATE                  grounded answer over surviving evidence
  │
VERIFY                    two-tier groundedness gate
  │
  ├── not grounded & repairs left ──► REPAIR (regenerate) ──► VERIFY
  │
DONE
```

Worst case is `maxSubQueries × (1 + maxRewrites)` retrievals plus
`1 + maxRepairs` generations. With the defaults: 9 retrievals, 2 generations.
`assertBudgetSane()` rejects a configuration allowing more than 24 retrievals or
4 generations **before any model call**, so a bad `.env` fails in milliseconds
rather than after forty requests.

## 3. Files added

```
src/workflow/
  graph.ts             the orchestrator: plain if/for, bounded loops, event trace
  nodes/plan.ts        decompose the question into retrievable sub-queries
  nodes/grade.ts       judge each passage against the sub-query
  nodes/rewrite.ts     produce a better query after a failure
  nodes/verify.ts      two-tier groundedness gate + repair directive builder
  web-search.ts        WebSearchProvider: offline | ollama | openrouter
  web-fixtures.ts      deterministic fixture corpus for the offline provider
src/cli/
  research.ts          bun run research
```

## 4. The nodes, and their failure policies

The most important design decision in this stage is that **different nodes fail
in different directions**, deliberately.

| Node | On failure | Why |
|---|---|---|
| PLAN | fail **open** → use the raw question | Degrades to exactly Stage 2 behaviour: never worse than not planning |
| GRADE | fail **open** → assume `partial` | A flaky grader must never be able to silently delete correct evidence |
| REWRITE | fail **terminal** → stop rewriting | Retrying a rewriter that just failed on the same input is a spin |
| VERIFY | fail **closed** → `grounded: false, confident: false` | An unverified answer must never be presented as verified |

`safeGenerateObject` (in `core/resilience.ts`) is what makes this expressible: it
returns a result type instead of throwing, so each node encodes its own policy in
three lines rather than a try/catch pyramid. It also logs the raw text from
`NoObjectGeneratedError`, which is the single most useful artifact when a grader
misbehaves on a small local model.

### PLAN

Vector search retrieves on similarity to a **single point** in embedding space. A
compound question has no single point — its embedding is the average of two
topics, often near neither. Splitting first is a correctness fix, not an
optimisation.

The schema caps at 4 sub-queries and the instructions say *do not pad*. Duplicate
sub-queries are removed in code after generation, because models routinely emit
two that normalise to the same string.

### GRADE — the highest-leverage node in the graph

Cosine similarity measures topical proximity, not evidential value. For *"what is
the default chunk overlap"*, all of these score highly:

- a passage defining what overlap *is* → topical, no answer
- a passage about overlap in a *different* system → topical, wrong answer
- a passage stating the default → **the answer**

Similarity cannot separate them. A model reading them can. Verdicts are
`relevant | partial | irrelevant`, and the sufficiency rule is deliberately
asymmetric:

```
sufficient = relevantCount >= 1 || partialCount >= 2
```

One `relevant` passage is enough. Otherwise **two** `partial` passages are
required — a single tangential passage is exactly the input that produces a
confident, wrong, well-cited answer.

All passages are graded in **one call**, not one call each. Per-passage calls cost
N× and, worse, remove the grader's ability to *compare*: judging six together
lets it mark the one that states the fact `relevant` and the five that merely
mention the topic `partial`. The cost is that one malformed response affects the
batch — which is why the fallback is per-label (`partial`) rather than
all-or-nothing. Labels are normalised on the way in (`s1`, `[S1]` → `S1`), and
only positively-rejected passages are discarded.

### REWRITE — a cycle in the graph

A rewrite node is a cycle, and cycles are where agent pipelines hang. Three
constraints keep it finite:

1. **The caller owns the budget.** `maxRewrites` lives in `graph.ts`; the node
   cannot schedule itself.
2. **Non-progress is rejected.** If the rewrite normalises to something already
   tried, it returns `progressed: false` and the graph stops rewriting
   immediately rather than spending the remaining budget on cosmetic variations.
3. **Failure is terminal, not retried.**

The strategies are named in the schema (`terminology | narrow | broaden |
decompose`), which both improves output and makes the trace legible.

### WEB SEARCH — the escape hatch

Behind a two-method interface, with three implementations:

- `offline` — deterministic fixtures (default). Token-overlap scoring over a
  hand-written corpus about topics the local corpus deliberately does **not**
  cover. Crude on purpose: its job is to be explainable, so a failing run points
  at the graph rather than the search backend.
- `ollama` — the provider's hosted `web_search` tool, invoked by calling the
  tool's `execute` directly with a synthetic execution context (no model is
  deciding to search here; the graph already decided).
- `openrouter` — the `:online` web plugin, with findings forced into a schema.

**Failure is never fatal.** Every provider degrades to an empty result set with a
recorded reason, and the graph treats "no web results" exactly like "no relevant
local passages": it abstains. Losing the fallback costs coverage, never
correctness. The non-offline paths also refuse to trust the response shape — a
provider can return an error object with a 200, and crashing inside the fallback
that exists to prevent crashes is a poor outcome.

Web sources render into the same `<source>` shape as local ones, with labels
continuing the local sequence (`S4`, `S5`…) and `origin="web"`. The generator
needs no special case. Context budget reserves up to 30% for web results, so a
large local context cannot squeeze out the very evidence we fell back to fetch.

### VERIFY — two tiers, cheapest first

**Tier 1 — deterministic, no model call.** `auditCitations` catches invented
labels (`[S9]` when only S1–S4 exist) and long uncited assertions. Free, cannot
itself hallucinate, catches the most common failure. If it fails, we do not spend
a model call to confirm what we already know.

**Tier 2 — semantic, one structured call.** Catches what Tier 1 cannot see: a
sentence carrying a *valid* citation whose source does not actually support it.
Citation-shaped text is not evidence. Problems are classified as
`not-in-source | contradicts-source | no-citation | overstated`.

The tiers are then **reconciled, with Tier 1 winning**: if there are long uncited
assertions, the answer is not grounded regardless of what the semantic verifier
said. A verifier that overrules a deterministic check is a verifier you cannot
trust.

An abstention is treated as grounded — it asserts nothing unsupported.

### REPAIR

One bounded regeneration, and only for a **confident** failure. If verification
could not run, another generation pass cannot fix anything and would just burn
tokens.

`buildRepairDirective` names the specific offending sentences rather than saying
"be more careful", which converts an abstract instruction into a concrete edit
list. Two details:

- The directive is appended to the **question**, not the instructions. The
  grounding contract stays byte-identical across passes, so it remains
  prompt-cacheable and cannot be weakened by the repair.
- The directive explicitly permits abstention: *"if, after removing unsupported
  claims, the sources no longer answer the question, abstain rather than produce
  a thin answer."* Without that, repair pressure produces hedging.

## 5. Pitfalls specific to this stage

**Unbounded self-correction.** Every loop is a `for` with a numeric ceiling, and
`assertBudgetSane` refuses a configuration that would allow a runaway. There is no
`while (!done)` anywhere in the graph.

**A grader that eats your evidence.** Covered above: fail open, and only discard
positive `irrelevant` verdicts.

**A verifier that rubber-stamps.** Covered above: fail closed, and let the
deterministic tier overrule the semantic one.

**Repair loops that never converge.** Bounded at `maxRepairs` (default 1), and
skipped entirely when the verifier was unavailable.

**Cost opacity.** The CLI prints model-call count, token usage, per-sub-query
attempt tables, and the phase trace. `LOCALMIND_GRADER_MODEL` lets you point the
high-volume structured calls (plan, grade, rewrite, verify — four of the six
model calls in a clean run) at a cheaper model than the answering call.

## 6. Watching self-correction actually fire

```bash
bun run research "how does the kubernetes horizontal pod autoscaler decide to scale down?"
```

The local corpus has nothing on Kubernetes. Expected trace: retrieval returns
low-scoring passages → grade marks them all `irrelevant` → rewrite tries
different terminology → still irrelevant → rewrite budget spent → web fallback
returns the HPA fixture → the answer cites `S1` as a web source and states the
300-second stabilisation window. With `LOCALMIND_WEB_SEARCH=offline` that whole
path runs with no network.

## 7. Validation

```bash
bun run verify          # hermetic: budget guard, offline provider, label offsets
bun run verify --live   # adds: full workflow, verify phase ran, budget held
```

The live assertion checks the *invariants*, not the prose: actual retrievals
never exceed `maxSubQueries × (1 + maxRewrites)`, the `verify` phase appears in
the event log, and the verified answer cites no invented labels.

## 8. Where to go next

The four stages are a foundation, not a finished product. The obvious extensions,
in rough order of value:

1. **Hybrid retrieval.** Add LanceDB full-text search alongside the vector scan
   and fuse the rankings. Dense retrieval misses exact identifiers — error codes,
   flag names, version strings — which is precisely what technical users search
   for.
2. **Reranking.** `ai-sdk-ollama` exposes an embedding-based reranker. Over-fetch
   30, rerank to 6; usually a bigger quality win than any prompt change.
3. **Conversation.** Everything here is single-turn. Multi-turn needs history-aware
   query rewriting (*"what about the other one?"* is unembeddable alone) plus
   `pruneMessages` to keep the window bounded.
4. **Evaluation.** A fixed question set with expected source labels, scored on
   retrieval recall and citation precision. Without it, every prompt change is a
   guess. The `verify` harness is the natural place to hang it.
5. **A vector index.** Worth it past ~100k rows; below that the build cost
   exceeds the query time it saves.
