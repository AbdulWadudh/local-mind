# Chunking Strategies for Retrieval

Chunking is the process of splitting a document into retrievable units. It is the
highest-leverage decision in a retrieval pipeline, because no amount of
downstream sophistication recovers information that chunking destroyed.

## Why fixed-width chunking fails

A fixed-width splitter cuts every N characters regardless of structure. Two
distinct failures follow.

The first is sentence severance: a clause is split across two chunks, so neither
chunk contains a complete statement. The second, and more damaging, is subject
detachment. A chunk reading "the default is 60 seconds" has lost the noun it
describes. No user query resembles that text, so it is effectively unretrievable,
and if it is retrieved by accident the model cannot determine what it refers to.

## Recursive separator descent

The recommended approach splits on the most semantically meaningful boundary
available, falling back only when necessary. A typical separator ladder is:

1. Level-two headings
2. Level-three headings
3. Blank lines (paragraph boundaries)
4. Single newlines
5. Sentence terminators
6. Whitespace

A hard character slice is used only as the final fallback, which in practice is
reached only for minified or base64 content that contains no whitespace at all.

## Overlap

Overlap re-includes the trailing portion of the previous chunk at the start of
the next. The recommended overlap is 10 to 20 percent of the chunk size. For a
1200 character chunk, 180 characters of overlap is a reasonable default.

Overlap must always be strictly smaller than the chunk size. If overlap equals or
exceeds the chunk size, the splitter emits the same window forever and never
advances through the document.

Overlap has a cost: adjacent chunks now share text verbatim. If two adjacent
chunks are both retrieved and concatenated naively, the shared text is duplicated
in the prompt, which wastes context budget and can make a single claim appear to
be corroborated by two independent sources. The fix is to stitch adjacent chunks
by locating the longest suffix of the first that is a prefix of the second, and
removing it.

## Contextual chunk headers

A chunk should be embedded with more context than it is displayed with.
Prepending the document title and the heading breadcrumb to the text that is
embedded restores the subject that splitting removed, while keeping the displayed
text verbatim so quotations remain exact.

Concretely: embed "Timeouts > Retry policy" followed by "The default is 60
seconds", but display only "The default is 60 seconds".

## Chunk size selection

Smaller chunks retrieve more precisely but carry less context. Larger chunks
carry more context but dilute the embedding, because a single vector must
represent several topics at once. For technical documentation, 800 to 1500
characters is a reasonable operating range. Below roughly 300 characters, chunks
become too topically thin to rank reliably; above roughly 2000 characters,
embedding dilution measurably degrades ranking quality.
