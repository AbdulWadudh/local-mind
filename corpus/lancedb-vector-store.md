# LanceDB as an Embedded Vector Store

LanceDB is an embedded vector database. It runs in-process and stores data as
files on disk, so it requires no server, no container, and no network
credentials. For local-first retrieval systems this removes an entire class of
operational concern.

## Storage model

Data is stored in the Lance columnar format, which is designed for random access
over large datasets. A LanceDB database is a directory; each table is a
subdirectory within it. Opening a database is a filesystem operation, not a
connection handshake.

## Declare the schema explicitly

LanceDB can infer a table schema from the first batch of rows written to it. For
vector data this is a mistake, for two reasons.

First, vector columns must be a fixed-size list, not a variable-length list.
Schema inference sees an array of numbers and may produce a variable-length list
column, which cannot carry a vector index. Search then silently degrades to a
brute-force scan, or fails outright when an index is added later.

Second, numeric width and nullability are inferred loosely. An integer column may
be inferred as a 64-bit float, after which an equality predicate against an
integer literal will not match any row.

Declaring the schema up front, with the vector column as a fixed-size list of
32-bit floats and metadata columns given explicit widths and nullability, avoids
both problems.

## Distance metrics

The distance metric is set per query. LanceDB supports L2, cosine, and dot
product. L2 is the default, so a text retrieval system must set cosine
explicitly; relying on the default is a common source of poor ranking.

Query results include a distance column named `_distance`. For a cosine query
this value is 1 minus cosine similarity, so a similarity score is obtained by
subtracting it from 1.

## Idempotent writes with merge-insert

Appending rows on every ingestion run duplicates the corpus. Merge-insert
resolves this: rows are matched on a key column, matched rows are updated in
place, and unmatched rows are inserted.

This makes re-ingestion idempotent provided the key is deterministic. Deriving a
chunk identifier from a hash of the document identifier, the chunk index, and the
document content hash gives exactly that property: unchanged content produces the
same key, so re-running ingestion updates rather than duplicates, and an
interrupted ingestion can simply be re-run.

## Vector indexes and when to build one

For small tables a brute-force scan is fast enough and exact. An approximate
index trades a small amount of recall for a large reduction in query latency, and
becomes worthwhile at roughly one hundred thousand rows. Below that threshold the
index build cost usually exceeds the query time it saves.

## Filtering

Metadata predicates are expressed as SQL over the columns of the table. By
default LanceDB applies the filter before the vector scan, which is efficient but
can return fewer than the requested number of results when the filter is highly
selective. Post-filtering, applied after the vector search, is available for cases
where the filter is expected to remove only a small fraction of rows.
