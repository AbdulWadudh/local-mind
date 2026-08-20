# Stage 3 — Delegate

**Capability gained:** the model owns retrieval. It decides what to search for,
how to reformulate after a miss, and when it has enough to answer.

```bash
bun run agent "what chunk overlap should I use and which distance metric?"
```

---

## 1. The problem this layer solves

Stage 2 embeds your question verbatim and searches once. Three cases break it,
and all three are common:

| Case | Why it fails |
|---|---|
| Compound — *"what overlap AND which metric"* | One embedding lands at the average of two topic regions, close to neither |
| Conversational — *"why is it so slow"* | Shares no vocabulary with the documentation that answers it |
| Vocabulary mismatch | You say "timeout", the corpus says "deadline" |

All three are fixed by transforming the query *before* searching. Transforming it
well requires understanding the question, which requires a model in the loop —
and that is precisely what makes retrieval "agentic". Nothing more mystical than
that.

Run the comparison yourself:

```bash
bun run ask   "what chunk overlap should I use and which distance metric?"   # 1 query
bun run agent "what chunk overlap should I use and which distance metric?"   # 2 queries
```

The retrieval log in the agent output shows the decomposition happening.

## 2. Files added

```
src/agent/
  trace.ts             per-run state: stable labels, evidence pool, loop bookkeeping
  tools.ts             searchKnowledgeBase, listKnowledgeSources, finalAnswer
  retrieval-agent.ts   ToolLoopAgent wiring, stop conditions, graceful degradation
src/cli/
  agent.ts             bun run agent
```

No framework. The only control-flow primitives are the ones the AI SDK actually
has: `tool()`, `stopWhen`, `prepareStep`, `activeTools`, `onStepFinish`.

## 3. The cost of freedom: three new failure modes

Handing the model a search tool introduces three failures that Stage 2 could not
have. All three are handled in `src/agent/tools.ts`, not hoped away.

### 3.1 Degenerate loops

A model whose query returns nothing will retry the same query — or a trivial
rewording — indefinitely.

Detection is easy: normalise (lowercase, strip punctuation, collapse whitespace)
and compare against history. **What you do on a repeat is the part that matters.**
A repeated query does *not* re-run the search. It returns a steering message:

> You have already searched for "cosine distance". Repeating it will return the
> same passages. Queries already tried: "cosine distance", "vector metric".
> Either search for a materially different term, or call `finalAnswer` with what
> you have.

That is cheaper than a search *and* strictly more informative than a second empty
result, which merely invites a third attempt. The CLI reports blocked repeats
explicitly, so you can see the guard earning its keep.

### 3.2 Tool-result context blowup

This one is easy to miss because nothing errors. Tool results are appended to the
conversation and **re-sent on every subsequent step**. Six 300-token passages
across four steps is roughly 7k tokens of duplicated evidence. On an 8k-context
local model that silently evicts the system instructions — and the model stops
following rules it can no longer see.

Two mitigations, applied together:

- **A per-call token budget** (`PER_CALL_TOKEN_BUDGET = 900`), spent across the
  hits, with `MAX_EXCERPT_TOKENS = 320` so one huge chunk cannot consume it all.
  Excerpts are truncated and flagged.
- **A hard cap on searches per run**, derived as
  `clamp(maxSteps - 1, 2, 6)`, leaving headroom for the answering step.

### 3.3 Unstable citation labels

If each tool call numbered its own results `S1..S5`, then `S2` would mean a
different passage in step 1 than in step 3, and every citation in the final
answer would be unreliable.

`trace.labelFor(chunk)` assigns a label **once per chunk id, for the lifetime of
the run**. That is the single most important line in `trace.ts`.

## 4. Stopping is the whole problem

An agent loop has exactly one catastrophic failure — not stopping — reachable
three ways: the model never calls the terminal tool; it repeats a failing query;
or it interleaves text and tool calls forever. So there are **four independent
brakes**, and the run reports which one engaged.

```ts
stopWhen: [hasToolCall('finalAnswer'), isStepCount(maxSteps)]
```

**Brake 1 — the terminal tool.** `finalAnswer` exists for control flow, not
computation. Paired with `hasToolCall`, it gives the loop a deterministic exit the
model chooses *explicitly*. Without it, "done" is inferred from the model emitting
text instead of a tool call — which small models do accidentally, mid-reasoning,
constantly. Its schema also forces a self-report: `citedLabels` and a
`confidence` of `high | medium | low | insufficient`.

**Brake 2 — the step limit.** `isStepCount(maxSteps)` is the cost backstop.

**Brake 3 — pressure before the limit, via `prepareStep`.**

```ts
prepareStep: ({ steps }) => {
  const exhausted = trace.remainingSearches() === 0;
  const nearLimit = steps.length >= options.maxSteps - 2;
  if (exhausted || nearLimit) return { activeTools: [FINAL_ANSWER_TOOL] };
  return {};
}
```

This is the most useful pattern in the stage. Telling a model to stop searching
is a *suggestion*. Removing the tool from the request is a *guarantee* — an
absent tool is not callable. `prepareStep` runs before each model call, which
makes it the right place for pressure that depends on how far the run has gone.

**Brake 4 — below the loop.** If the loop ends with no committed answer, we do
not fail. The trace already holds every passage retrieved, so we fall back to a
plain Stage 2 grounded generation over that evidence. A partially-successful agent
run still produces a cited answer; only a *retrieval* failure produces nothing —
and that case throws `AGENT_LOOP_EXHAUSTED` with a remedy pointing at
`bun run ask` to isolate whether the model can emit valid tool calls at all.

The four resulting outcomes are surfaced as `stopReason`:

| `stopReason` | Meaning |
|---|---|
| `final-answer-tool` | the intended exit |
| `model-emitted-text` | prose instead of a tool call; common on small models, usually fine |
| `step-limit` | budget ran out before the model committed |
| `fallback-synthesis` | loop produced nothing; answer synthesised from the evidence pool |

## 5. Tool design notes

**Errors are returned as data, not thrown.** A thrown tool error aborts the whole
generation. Returning `{status: 'no-results', guidance: 'the backend errored…'}`
lets the model try a different query. Every tool result carries a `guidance`
field, always populated — including a nudge when the top score is barely above
threshold (*"top relevance is only 0.31; these passages may be tangential"*).

**Descriptions are instructions.** The `searchKnowledgeBase` description tells
the model *one topic per call*, *prefer documentation terminology*, and *do not
repeat a query*. Zod `.describe()` on each field does the same at parameter level.
This is where most tool-calling quality comes from, and it is worth more effort
than the system prompt.

**`listKnowledgeSources` exists to enable honest refusal.** Without it, a model
asked about a topic the corpus does not cover has no way to know that, so it
searches repeatedly. With it, one call establishes coverage.

## 6. Validation

```bash
bun run verify          # hermetic: labels, repeat detection, budget, evidence pool
bun run verify --live   # adds: agent retrieves, terminates, invents no labels
```

Hermetic assertions: the same chunk keeps its label across calls; different
chunks get different labels; `"Cosine Distance, Explained!"` and
`"cosine distance explained"` are the same query; the search budget is finite and
refuses the call past it; the evidence pool keeps the best score seen for a chunk
rather than the last.

The live test asserts the *loop properties* — terminates within `maxSteps`,
cites no invented labels — not the answer text, which is not deterministic and
differs between an 8B local model and a frontier model.

## 7. What Stage 3 cannot guarantee

This is the honest limitation, and it is the reason Stage 4 exists.

Stage 3 delegates control flow to the model. You therefore **cannot guarantee any
particular step happened**. You cannot guarantee it graded the passages it
retrieved before answering from them. You cannot guarantee it verified its own
answer. *"Check your work"* is just another instruction it may ignore — and when
it does ignore it, the output looks identical to when it did not.

For open-ended questions that trade-off is correct: flexibility is worth more
than a guarantee. When specific steps must be guaranteed, take the control flow
back into program code. That is [Stage 4](4-verify.md).
