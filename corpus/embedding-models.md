# Embedding Models and Vector Spaces

An embedding model maps text to a fixed-length vector of floating point numbers.
Semantic similarity between two pieces of text is approximated by the geometric
relationship between their vectors.

## Dimensionality

Every embedding model produces vectors of a fixed dimensionality, and that number
is a property of the model, not a configuration option.

- nomic-embed-text produces 768 dimensions
- mxbai-embed-large produces 1024 dimensions
- text-embedding-3-small produces 1536 dimensions
- text-embedding-3-large produces 3072 dimensions

Higher dimensionality is not automatically better. It increases index size and
query cost linearly, while retrieval quality depends far more on the training
data and objective of the model than on its width.

## The vector space is not portable

This is the single most important operational property of embeddings: two
different models produce vectors that live in incompatible spaces, even when the
dimensionality happens to match.

The practical consequence is a failure mode with no error message. If an index is
built with one model and queried with another of the same width, every query
vector lands in an unrelated region of the space. Retrieval returns results, the
scores look plausible, and the results are semantically random.

The mitigation is to record the provider, the model identifier, and the
dimensionality alongside the index, and to compare them before every query.
Detecting the mismatch is the only way to turn a silent quality collapse into a
visible failure.

## Cosine similarity versus Euclidean distance

Cosine similarity compares the direction of two vectors and ignores their
magnitude. Euclidean, or L2, distance accounts for both.

Text embedding models are generally trained with a cosine objective, and their
output is not consistently unit-normalised across providers. Using L2 distance on
un-normalised vectors conflates topical difference with passage length, so longer
passages appear less similar merely because their vectors are longer. Cosine is
therefore the correct default for text retrieval.

Cosine similarity ranges from -1 to 1, where 1 means identical direction. Many
vector databases report cosine distance instead, defined as 1 minus cosine
similarity, so 0 means identical. Converting between them is a subtraction, but
confusing them inverts the ranking.

## Zero vectors and degenerate inputs

A zero vector has no direction, so its cosine similarity to anything is
undefined. A vector database will store one without complaint and then return it
for every query with a distance of NaN or 1. Empty or whitespace-only input is
the usual cause. Validating vectors at ingestion time is cheaper than debugging a
poisoned index later.

## Query and document asymmetry

Some embedding models are trained with distinct prefixes for queries and
documents, for example "search_query:" and "search_document:". Models in the E5,
BGE and Nomic families commonly expect this. If a model expects prefixes and they
are omitted, retrieval quality drops without any error being raised. Prefixes
must be applied consistently: mixing prefixed and unprefixed vectors in one index
is silent quality loss.
