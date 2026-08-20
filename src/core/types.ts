/**
 * The shared domain vocabulary for every stage.
 *
 * These types are deliberately flat and `readonly`: they cross a process
 * boundary (LanceDB rows), a network boundary (tool results serialised into the
 * model's context) and a UI boundary (CLI rendering). Keeping them free of
 * classes and methods means any of those crossings is a pure structural copy.
 */

/** A file read off disk, normalised, before any splitting has happened. */
export interface SourceDocument {
  /** Stable slug derived from the path relative to the corpus root. */
  readonly id: string;
  readonly title: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly text: string;
  readonly charCount: number;
  /** sha256 of `text`; changes here are what make re-ingestion idempotent. */
  readonly contentHash: string;
}

/** One retrievable unit of a document. */
export interface Chunk {
  /** Deterministic: sha256(documentId + chunkIndex + contentHash). */
  readonly id: string;
  readonly documentId: string;
  readonly title: string;
  readonly relativePath: string;
  /** Markdown heading breadcrumb, e.g. "Retrieval > Hybrid search". */
  readonly headingPath: string;
  readonly chunkIndex: number;
  readonly charStart: number;
  readonly charEnd: number;
  readonly tokenEstimate: number;
  readonly contentHash: string;
  /** Verbatim slice of the source document. This is what a human reads. */
  readonly text: string;
  /**
   * What actually gets embedded: `headingPath` + `title` prepended to `text`.
   * A chunk that says "it defaults to 60 seconds" is meaningless on its own;
   * the breadcrumb restores the subject the sentence lost at the split.
   */
  readonly embedText: string;
}

export interface EmbeddedChunk extends Chunk {
  readonly vector: readonly number[];
}

/** A chunk that came back from a vector search, with its score attached. */
export interface RetrievedChunk {
  readonly id: string;
  readonly documentId: string;
  readonly title: string;
  readonly relativePath: string;
  readonly headingPath: string;
  readonly chunkIndex: number;
  readonly text: string;
  readonly tokenEstimate: number;
  /** Cosine distance straight from LanceDB (`_distance`), 0 = identical. */
  readonly distance: number;
  /** `1 - distance`, clamped to [0, 1]. Higher is better. */
  readonly score: number;
}

/**
 * Written next to the LanceDB directory on every ingest.
 *
 * This file is the guard against the single most common local-RAG bug: you
 * re-run ingestion after switching embedding models, the new vectors land in a
 * table built for the old dimension (or worse, the same dimension but a
 * different vector space), and retrieval silently degrades to noise.
 */
export interface IndexManifest {
  readonly manifestVersion: 1;
  readonly embeddingProvider: string;
  readonly embeddingModel: string;
  readonly dimensions: number;
  readonly chunking: {
    readonly maxChars: number;
    readonly overlapChars: number;
  };
  readonly documentCount: number;
  readonly chunkCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A `[S1]`-style label bound to the chunk it points at. */
export interface Citation {
  readonly label: string;
  readonly chunkId: string;
  readonly title: string;
  readonly relativePath: string;
  readonly headingPath: string;
  readonly score: number;
  readonly origin: 'corpus' | 'web';
  readonly url?: string;
}

export interface WebResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/** Retrieval is behind an interface so M3/M4 can swap in fakes for tests. */
export interface RetrievalOptions {
  readonly topK?: number;
  readonly minScore?: number;
  /** SQL-ish predicate applied before the vector scan, e.g. `title = 'X'`. */
  readonly where?: string;
}

export interface Retriever {
  search(query: string, options?: RetrievalOptions): Promise<readonly RetrievedChunk[]>;
  listSources(): Promise<readonly { title: string; relativePath: string; chunkCount: number }[]>;
  close(): Promise<void>;
}
