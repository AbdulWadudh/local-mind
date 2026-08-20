# Grounding, Citation and Abstention

A retrieval system that fetches the right passages and then answers from memory
anyway is worse than no retrieval at all, because it looks trustworthy.
Grounding is the set of constraints that binds generation to retrieved evidence.

## The closed-world instruction

Instructing a model to use only the provided sources is necessary but
insufficient. A model that partially remembers an answer will pattern-match the
sources against its memory and present the blend, which is fluent, plausible, and
partly invented.

The instruction becomes materially more effective when it names the failure mode
directly: state that information known from training must not be asserted even
when the model is confident it is true. Naming the specific behaviour to suppress
is more reliable than a general prohibition.

## Sentence-level citation

Paragraph-level citation allows one invented clause to sit inside four sourced
ones, where it is undetectable. Requiring a citation label on every sentence that
asserts a fact makes an uncited claim syntactically visible.

That visibility is what makes automated auditing possible. Two checks require no
model call at all: verifying that every citation label used in the answer exists
in the source list, and flagging substantive sentences that carry no label. The
first catches invented references; the second catches uncited assertion.

## Abstention needs to be machine-readable

Instructing a model to say it does not know produces hedged prose such as: the
sources do not fully specify this, but typically it is around thirty seconds.
That is a hallucination with a disclaimer attached.

Requiring a fixed, literal marker instead makes abstention a state the calling
program can branch on. A pipeline can then react: fall back to another source,
widen the query, or report the gap to the user. Abstention becomes control flow
rather than prose.

## Relevance is not evidential value

Vector similarity measures topical proximity, not whether a passage answers a
question. For the query "what is the default chunk overlap", all of these score
highly: a passage defining what overlap is, a passage discussing overlap in a
different system, and the passage stating the default. Only the last is evidence.

Similarity cannot distinguish them because they are all about overlap. A model
reading the passages can. This is why a grading step, in which a model judges
each retrieved passage against the query before generation, is the highest-value
addition to a naive retrieval pipeline.

## Verification and the limits of self-checking

A groundedness check asks whether every claim in an answer is supported by the
source it cites. It catches the failure that citation-shaped text conceals: a
claim carrying a valid label whose source does not actually support it.

Verification should fail closed. If the check cannot be performed, the answer
must be reported as unverified rather than assumed correct. This is the opposite
policy from relevance grading, which should fail open, because a flaky grader
must never be able to silently discard correct evidence.
