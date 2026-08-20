# Agentic Retrieval Patterns

A single retrieval pass embeds the question verbatim and searches once. This is
sufficient for direct, single-topic questions and fails predictably everywhere
else.

## When single-pass retrieval fails

Three cases account for most failures. Compound questions contain two topics, so
their embedding lands at the average of two regions and is close to neither.
Conversational questions such as "why is it so slow" share no vocabulary with the
documentation that answers them. Vocabulary mismatch occurs when the user and the
corpus use different words for the same concept.

All three are addressable by transforming the query before searching, which
requires a model in the loop, which is what makes retrieval agentic.

## Retrieval as a tool

Exposing search as a callable tool lets the model decide when to search, what to
search for, and how many times. It can decompose compound questions, translate
conversational phrasing into documentation terminology, and retry after a failed
attempt.

The cost of that freedom is three new failure modes.

## Failure mode: degenerate loops

A model whose query returns nothing will frequently retry the same query, or a
trivial rewording of it, indefinitely. Detecting repeats by normalising the query
(lowercasing and stripping punctuation) and comparing against history is
effective. The important detail is what to do on a repeat: returning a message
that states what was already tried and what to do instead applies forward
pressure, whereas returning a second empty result invites a third attempt.

## Failure mode: tool-result context growth

Tool results are appended to the conversation and re-sent on every subsequent
step. Six passages of three hundred tokens each, over four steps, is roughly
seven thousand tokens of duplicated evidence. On a model with an eight thousand
token window this silently evicts the instructions, and the model stops following
rules it can no longer see.

Two mitigations apply together: a token budget per tool result, enforced by
truncation, and a hard cap on the number of tool calls per turn.

## Failure mode: unstable citation labels

If each tool call numbers its results independently, label S2 refers to a
different passage in step one than in step three, and every citation in the final
answer is unreliable. Labels must be assigned once per passage for the lifetime
of the run.

## Stopping conditions

An agent loop has one catastrophic failure, which is not stopping. Robust loops
use several independent brakes rather than one.

A terminal tool that the model calls to submit its final answer provides a
deterministic, intentional exit. A step limit provides a cost backstop. Budgets
inside the tools themselves apply pressure toward the terminal tool before the
step limit is reached. Removing tools from the request once their budget is spent
is stronger than instructing the model to stop using them, because an instruction
is advisory and an absent tool is not callable.

A fourth brake sits below the loop: if it ends without a committed answer, the
evidence gathered so far is still available, and a single-pass grounded generation
over that evidence produces a cited answer. A partially successful agent run
should still return something useful.

## Model-driven versus code-driven control flow

Tool loops delegate control flow to the model, which suits open-ended tasks. The
trade-off is that no particular step can be guaranteed to have occurred: asking a
model to check its own work is just another instruction it may ignore.

When specific steps must be guaranteed, express the control flow in ordinary
program code and call the model only for the judgements that require language
understanding. Every transition becomes inspectable, every loop carries a numeric
bound, and identical inputs follow identical paths.
