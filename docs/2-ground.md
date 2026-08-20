# Stage 2 — Ground

**Capability gained:** the model answers, streamed, using *only* the retrieved
passages — citing each claim, and abstaining when the evidence is not there.

```bash
bun run ask "why is cosine preferred over L2 for text embeddings?"
```

---

## 1. The problem this layer solves

Stage 1 hands you the right passages. The failure mode this stage prevents is the
model receiving them and answering from memory anyway.

That failure is worse than no retrieval at all, because it *looks* trustworthy: a
fluent answer, sourced-looking, with the invented part indistinguishable from the
sourced part. A retrieval system that is right 90% of the time and confidently
wrong 10% of the time, with no signal separating them, is not usable for anything
that matters.

So this stage is about three things, in order of importance:

1. **Binding** the answer to the evidence (the grounding contract).
2. **Making violations detectable** (sentence-level citation + a deterministic audit).
3. **Making abstention a program state** rather than a hedge in prose.

## 2. Files added

```
src/generation/
  prompt.ts            the grounding contract + query-rewrite instructions
  grounded-answer.ts   streaming and non-streaming grounded generation
src/retrieval/
  context.ts           context assembly, overlap stitching, citation audit
src/cli/
  ask.ts               bun run ask
```

`context.ts` lives under `retrieval/` rather than `generation/` on purpose: it
consumes `RetrievedChunk[]` and knows nothing about models. Stage 4 reuses it for
web sources.

## 3. Context assembly: three failure modes

`assembleContext()` turns a ranked list into the exact string that goes in the
prompt, plus the citation table used to verify the output afterwards. Each of the
three things it does exists to prevent a different kind of bad answer.

### 3.1 Context drift / lost-in-the-middle

Dumping twenty chunks in arbitrary order buries the good evidence. Blocks are
emitted strongest-first, each tagged with its relevance score, so the model can
*weigh* sources rather than average them:

```
<source id="S1" title="Embedding Models" path="embedding-models.md"
        section="Cosine similarity versus Euclidean distance" relevance="0.772">
…verbatim passage…
</source>
```

XML-ish delimiters, not markdown headers, because models respect them as
boundaries far more reliably — and the attributes give the model the metadata it
needs to say *"S1 and S3 disagree"*.

### 3.2 Overlap duplication

Stage 1 chunked *with* overlap, so adjacent chunks share text verbatim.
Concatenating two neighbours naively spends budget on duplicated sentences and,
worse, makes one claim appear corroborated by two independent sources.

`mergeAdjacentChunks` folds neighbours (same document, consecutive
`chunkIndex`), and `stitchOverlap` removes the seam by finding the longest suffix
of the first that is a prefix of the second — bounded to the last 600 characters,
since the seam can never exceed the configured overlap and an unbounded search
would be quadratic.

A merged candidate keeps the **maximum** score of its parts, not the mean.
Averaging would push a genuinely relevant passage below threshold merely because
it sits next to a weak one.

### 3.3 Silent budget overflow

Exceed the window and the provider truncates from one end — usually taking your
instructions or your best source with it. So the budget is spent explicitly,
best-first, with a documented policy for a partial fit:

- fits → include whole
- does not fit, but ≥40% of it would → truncate and mark `truncated: true`
- less than that → drop it and record the id

The 40% floor matters. A 15% fragment is *worse* than nothing: it reads as
evidence while omitting the clause that qualifies the claim.

> **A real bug this caught.** The first implementation appended the
> `[... truncated ...]` marker *after* the budget check, overshooting by 5 tokens
> (405 > 400). The harness failed, and `truncateToTokens` now reserves the
> marker's cost up front and enforces
> `estimateTokens(result) <= maxTokens` as a post-condition on the final string.
> That class of bug ships easily: the overshoot only bites at the exact moment
> the budget matters, which is when the window is already full.

## 4. The grounding contract

`GROUNDED_ANSWER_INSTRUCTIONS` in `src/generation/prompt.ts`. Four rules carry
almost all the weight, and *why* each is phrased the way it is matters more than
the phrasing:

**1. Closed world — name the failure, not just the rule.** "Use only the
sources" is insufficient. A model that half-remembers the answer will
pattern-match the sources against its memory and present the blend. The
instruction has to say *"even if you are confident it is true"* for the rule to
bind against that specific behaviour.

**2. Sentence-level citation.** Paragraph-level citation lets one invented clause
hide inside four sourced ones. Requiring a label on every claim-bearing sentence
makes the invented clause *syntactically* visible — which is precisely what makes
the automated audit possible. This rule exists to enable §5, not for the reader.

**3. An explicit abstention token.** "Say you don't know" produces *"the sources
don't fully specify, but typically it's around thirty seconds"* — a hallucination
with a disclaimer. `INSUFFICIENT_CONTEXT: <what is missing>` is machine-checkable,
so abstention becomes control flow. Stage 4 branches on it to trigger web search.

**4. No meta-commentary.** Small local models love *"Based on the provided
context, I can see that…"*. It burns the output budget and dilutes the answer.

Plus: quote numbers and identifiers character-for-character, and surface
conflicts explicitly (`"S1 states 30s while S3 states 60s [S1][S3]"`) rather than
silently picking one.

### The zero-source short circuit

If retrieval returned nothing, `generateGroundedAnswer` **does not call the
model**. The correct output is a deterministic abstention; asking a model to
produce it merely gives it an opportunity to answer from memory instead.
Refusing in code is cheaper and strictly safer.

## 5. Verification without a model

The model can only *use* citation labels; it can never *define* them — the table
is derived from the assembled context. That asymmetry makes `auditCitations()`
meaningful, and it is pure string work:

| Check | Catches |
|---|---|
| every `[S#]` in the answer exists in the table | invented references (`[S7]` when S1–S4 exist) |
| every substantive sentence carries a label | fluent uncited assertion |
| which labels went unused | over-retrieval; a tuning signal for `topK` |

This runs on every `bun run ask` and is reported in the grounding report. It costs
nothing, cannot itself hallucinate, and catches the most common failure. Stage 4
promotes it to Tier 1 of a two-tier verifier for exactly that reason.

## 6. Streaming

Two entrypoints, because they have genuinely different requirements:

- `streamGroundedAnswer` — interactive. Time-to-first-token on a local 8B model
  is 1–3s and total generation can be 30s; streaming is the difference between
  usable and abandoned. Returns `{ textStream, settled() }` so the caller renders
  deltas and *still* gets the citation audit afterwards. `settled()` awaits the
  SDK's own promises rather than re-accumulating text, so there is one source of
  truth.
- `generateGroundedAnswer` — programmatic. Stage 4 needs the complete text before
  it can verify it, so streaming would add only complexity.

Note `onError` on the `streamText` call: mid-stream failures are delivered there
rather than thrown. Without that handler, a dropped connection looks like a short
answer.

## 7. Validation

```bash
bun run verify          # hermetic: assembly, budget, stitching, audit
bun run verify --live   # adds: cites real sources; abstains on empty evidence
```

Hermetic assertions include: budget never exceeded, de-duplication of a chunk
passed twice, labels sequential and in descending score order, seam appears
exactly once after stitching, invented labels detected, uncited assertions
detected, empty input produces empty context rather than a crash.

## 8. What Stage 2 cannot do

It embeds your question **verbatim** and searches **exactly once**. Two
consequences you can reproduce:

```bash
# Compound: one averaged embedding, close to neither topic.
bun run ask "what chunk overlap should I use and which distance metric?"

# Conversational: shares no vocabulary with the documentation that answers it.
bun run ask "why is it so slow"
```

The first half-answers; the second abstains on a question the corpus *does*
cover. Both need the query transformed before searching — which needs a model in
the loop. That is [Stage 3](3-delegate.md).
