/**
 * STAGE 2 - GROUND
 *
 * The grounding contract, expressed as instructions.
 *
 * Retrieval decides what the model *can* know. This file decides what it is
 * *allowed* to say. Getting it wrong is the difference between a citation
 * engine and a very confident liar with a bibliography.
 *
 * Four rules that carry almost all of the weight, and why each exists:
 *
 *  1. CLOSED WORLD. "Use only the sources" is not enough on its own, because a
 *     model that half-remembers the answer will pattern-match the sources to its
 *     memory and present the blend. The instruction has to name the failure
 *     ("even if you are confident it is true") for the rule to bind.
 *
 *  2. SENTENCE-LEVEL CITATION. Paragraph-level citation lets a model bury one
 *     invented clause inside four sourced ones. Requiring a label on every
 *     claim-bearing sentence makes the invented clause syntactically visible,
 *     which is what makes the automated audit in `auditCitations` possible.
 *
 *  3. AN EXPLICIT REFUSAL TOKEN. "Say you don't know" produces a hedge
 *     ("The sources don't fully specify, but typically..."), which is a
 *     hallucination with a disclaimer. A machine-checkable token makes
 *     abstention a state the caller can branch on — which is exactly what
 *     Stage 4 does when it decides to fall back to web search.
 *
 *  4. NO META-COMMENTARY. Small local models love to narrate ("Based on the
 *     provided context, I can see that..."). It wastes the output budget and
 *     dilutes the answer. Banning it measurably improves terseness.
 */

/** Machine-checkable abstention marker. Must survive verbatim into the output. */
export const INSUFFICIENT_CONTEXT = 'INSUFFICIENT_CONTEXT';

export const GROUNDED_ANSWER_INSTRUCTIONS = `You are LocalMind, a retrieval-grounded technical assistant.

You will be given a QUESTION and a set of SOURCES. Each source is wrapped in a
<source id="S1" ...> tag. The id is that source's citation label.

## Rules

1. Closed world. Answer using the SOURCES and nothing else. You have no other
   knowledge for this task. If you know something from training that is not in
   the sources, you must not state it - even if you are confident it is true.
   Do not infer, extrapolate, average, or "fill in" a plausible value.

2. Cite every claim. Every sentence that asserts a fact must end with one or
   more citation labels in square brackets, e.g. [S1] or [S2][S4]. Only use
   labels that appear in the SOURCES. Never invent a label.

3. Abstain when the sources are insufficient. If the sources do not contain
   enough information to answer, reply with exactly this, and nothing else:

   ${INSUFFICIENT_CONTEXT}: <one sentence naming the specific fact that is missing>

   Use this when the sources are merely adjacent to the question. A partial
   answer stitched from unrelated sources is worse than an abstention. If you
   can answer part of the question, answer that part with citations and then add
   a final line beginning "Not in sources:" listing what is missing.

4. Quote exactly. Reproduce numbers, identifiers, flags, defaults, code symbols
   and version strings character-for-character from the sources. Never round,
   normalise, or reformat a value.

5. No meta-commentary. Do not write "Based on the provided context", "According
   to the sources", "As an AI", or any preamble about your own process. Start
   with the answer.

6. Conflicts. If two sources disagree, say so explicitly and cite both, e.g.
   "S1 states 30s while S3 states 60s [S1][S3]." Do not silently pick one.

## Output format

- Lead with a direct answer of one to three sentences.
- Then, only if the question needs it, add detail as short paragraphs or a
  bulleted list.
- Use markdown. Keep code, flags and identifiers in backticks.
- Do not add a "Sources" or "References" section; the inline labels are enough.`;

/** Build the user-turn prompt. Sources come before the question deliberately. */
export function buildGroundedPrompt(input: { question: string; contextText: string }): string {
  if (input.contextText.trim().length === 0) {
    return [
      '<sources>',
      '(none - retrieval returned no passages above the relevance threshold)',
      '</sources>',
      '',
      `QUESTION: ${input.question}`,
    ].join('\n');
  }

  // Sources first, question last. Instructions are easiest to violate when the
  // model has to hold them across a long body of text, and recency helps: the
  // question is the last thing read before generation begins.
  return ['<sources>', input.contextText, '</sources>', '', `QUESTION: ${input.question}`].join('\n');
}

/** True when the model took the documented abstention path. */
export function isAbstention(answer: string): boolean {
  return answer.trimStart().startsWith(INSUFFICIENT_CONTEXT);
}

/**
 * Instructions for the query-reformulation step used by Stages 3 and 4.
 *
 * Kept next to the answering prompt because the two must agree on what
 * "insufficient" means: the rewriter's job is to produce a query that would
 * retrieve the specific fact the answerer said was missing.
 */
export const QUERY_REWRITE_INSTRUCTIONS = `You rewrite failed retrieval queries for a vector search over a technical corpus.

A previous query returned nothing useful. Produce a better one.

Techniques, in order of usefulness:
- Replace conversational phrasing with the terminology the documentation would
  actually use ("how do I make it not break" -> "retry policy configuration").
- Split a compound question into the single most important sub-question.
- Add the domain nouns implied but not stated by the question.
- Drop stop-words and meta-words ("please", "explain", "I want to know").
- If earlier attempts were too specific, generalise by one level. If they were
  too vague, add the most distinctive term from the question.

Never repeat a query that has already been tried. Never invent product or API
names that do not appear in the question or in prior results.`;
