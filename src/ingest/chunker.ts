import { LocalMindError } from '../core/errors';
import { createLogger } from '../core/logger';
import { sha256Hex } from '../core/fs';
import { estimateTokens } from '../core/tokens';
import type { Chunk, SourceDocument } from '../core/types';

/**
 * Structure-aware recursive chunking with overlap.
 *
 * THE PROBLEM THIS SOLVES
 * A naive `text.match(/.{1,1200}/g)` splitter is the number-one cause of bad
 * RAG. It severs sentences mid-clause, and — worse — it detaches statements
 * from their subject. A chunk that reads "the default is 60 seconds" is
 * unretrievable: no user query looks like that, and even if it were retrieved
 * the model cannot tell you *what* defaults to 60 seconds.
 *
 * THE THREE MITIGATIONS IMPLEMENTED HERE
 *  1. Recursive separator descent. We split on the most semantic boundary that
 *     works (H2 -> H3 -> paragraph -> line -> sentence -> word), and only fall
 *     back to a hard character slice when a single word exceeds the budget.
 *  2. Overlap. Each chunk re-includes the trailing `overlapChars` of its
 *     predecessor, snapped to a word boundary, so a fact that straddles a
 *     boundary appears whole in at least one chunk.
 *  3. Contextual chunk headers. The document title and the markdown heading
 *     breadcrumb are prepended to the text that gets *embedded* (`embedText`)
 *     but kept out of the text that gets *displayed* (`text`). This restores the
 *     lost subject for the retriever without polluting the quoted answer.
 */

const log = createLogger('ingest:chunker');

/** Ordered most-semantic-first. Leading `\n` keeps headings attached to bodies. */
const DEFAULT_SEPARATORS: readonly string[] = [
  '\n## ',
  '\n### ',
  '\n#### ',
  '\n\n',
  '\n- ',
  '\n',
  '. ',
  ' ',
];

/** Chunks smaller than this are merged forward instead of emitted alone. */
const MIN_CHUNK_CHARS = 64;

export interface ChunkOptions {
  readonly maxChars: number;
  readonly overlapChars: number;
  readonly separators?: readonly string[];
  readonly minChars?: number;
}

interface Range {
  readonly start: number;
  readonly end: number;
}

interface HeadingMarker {
  readonly offset: number;
  readonly level: number;
  readonly text: string;
}



/** Index every markdown ATX heading with its character offset. */
function indexHeadings(text: string): readonly HeadingMarker[] {
  const markers: HeadingMarker[] = [];
  const pattern = /^(#{1,6})\s+(.+)$/gmu;

  let match = pattern.exec(text);
  while (match !== null) {
    const hashes = match[1];
    const title = match[2];
    if (hashes !== undefined && title !== undefined) {
      markers.push({ offset: match.index, level: hashes.length, text: title.trim() });
    }
    match = pattern.exec(text);
  }

  return markers;
}

/**
 * Breadcrumb of the headings in effect at `offset`, e.g.
 * "Retrieval > Hybrid search". Headings at deeper levels seen earlier are
 * discarded when a shallower heading appears, which is what makes this a path
 * rather than a list.
 */
function headingPathAt(markers: readonly HeadingMarker[], offset: number): string {
  const stack: HeadingMarker[] = [];

  for (const marker of markers) {
    if (marker.offset > offset) break;
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top !== undefined && top.level >= marker.level) stack.pop();
      else break;
    }
    stack.push(marker);
  }

  // Drop the H1: it duplicates the document title.
  return stack
    .filter((marker) => marker.level > 1)
    .map((marker) => marker.text)
    .join(' > ');
}

/**
 * Recursively split `[start, end)` until every produced range fits `maxChars`.
 * Separators are kept at the START of the following piece, which is what keeps
 * a heading glued to the section it introduces.
 */
function atomize(
  text: string,
  start: number,
  end: number,
  maxChars: number,
  separators: readonly string[],
  depth: number,
): Range[] {
  if (end - start <= maxChars) return [{ start, end }];

  const separator = separators[depth];

  // Out of separators: hard-slice. Only reachable for pathological input such as
  // a minified blob or a base64 payload with no whitespace at all.
  if (separator === undefined) {
    const ranges: Range[] = [];
    for (let cursor = start; cursor < end; cursor += maxChars) {
      ranges.push({ start: cursor, end: Math.min(end, cursor + maxChars) });
    }
    return ranges;
  }

  const boundaries: number[] = [];
  let searchFrom = start + 1; // never split at position 0 of the window
  for (;;) {
    const hit = text.indexOf(separator, searchFrom);
    if (hit === -1 || hit >= end) break;
    boundaries.push(hit);
    searchFrom = hit + separator.length;
  }

  if (boundaries.length === 0) return atomize(text, start, end, maxChars, separators, depth + 1);

  const ranges: Range[] = [];
  let pieceStart = start;
  for (const boundary of [...boundaries, end]) {
    const pieceEnd = Math.min(boundary, end);
    if (pieceEnd <= pieceStart) continue;
    if (pieceEnd - pieceStart > maxChars) {
      ranges.push(...atomize(text, pieceStart, pieceEnd, maxChars, separators, depth + 1));
    } else {
      ranges.push({ start: pieceStart, end: pieceEnd });
    }
    pieceStart = pieceEnd;
  }

  return ranges;
}

/** Greedily merge atoms into the largest windows that still fit `maxChars`. */
function pack(atoms: readonly Range[], maxChars: number, minChars: number): Range[] {
  const packed: Range[] = [];
  let current: Range | undefined;

  for (const atom of atoms) {
    if (current === undefined) {
      current = atom;
      continue;
    }
    if (atom.end - current.start <= maxChars) {
      current = { start: current.start, end: atom.end };
      continue;
    }
    packed.push(current);
    current = atom;
  }
  if (current !== undefined) packed.push(current);

  // Fold a runt tail into its predecessor rather than emitting a 12-character
  // chunk that will match everything and mean nothing.
  if (packed.length >= 2) {
    const last = packed[packed.length - 1];
    const previous = packed[packed.length - 2];
    if (last !== undefined && previous !== undefined && last.end - last.start < minChars) {
      packed.splice(packed.length - 2, 2, { start: previous.start, end: last.end });
    }
  }

  return packed;
}

/** Move `index` left to the nearest whitespace so overlap never starts mid-word. */
function snapToWordStart(text: string, index: number, floor: number): number {
  if (index <= floor) return floor;
  const window = text.slice(floor, index);
  const lastBreak = window.search(/\s(?=\S*$)/u);
  if (lastBreak === -1) return index;
  return floor + lastBreak + 1;
}

/**
 * Split one document into overlapping, offset-accurate, heading-aware chunks.
 */
export function chunkDocument(document: SourceDocument, options: ChunkOptions): readonly Chunk[] {
  const { maxChars, overlapChars } = options;
  const separators = options.separators ?? DEFAULT_SEPARATORS;
  const minChars = options.minChars ?? MIN_CHUNK_CHARS;

  if (overlapChars >= maxChars) {
    throw new LocalMindError(
      'CHUNKING_FAILED',
      `overlapChars (${overlapChars}) must be smaller than maxChars (${maxChars}).`,
      { remedy: 'Set LOCALMIND_CHUNK_OVERLAP to roughly 10-20% of LOCALMIND_CHUNK_CHARS.' },
    );
  }

  const { text } = document;
  const headings = indexHeadings(text);
  const atoms = atomize(text, 0, text.length, maxChars, separators, 0);
  const packed = pack(atoms, maxChars, minChars);

  const chunks: Chunk[] = [];
  let previousStart = -1;

  for (const [index, range] of packed.entries()) {
    // Extend backwards for overlap, but never past the previous chunk's start:
    // that guarantees strictly increasing starts, i.e. termination.
    const desiredStart = index === 0 ? range.start : Math.max(0, range.start - overlapChars);
    const flooredStart = Math.max(desiredStart, previousStart + 1);
    const start = snapToWordStart(text, flooredStart, Math.max(0, flooredStart - 40));
    const end = range.end;

    const slice = text.slice(start, end).trim();
    if (slice.length === 0) continue;

    previousStart = start;

    const headingPath = headingPathAt(headings, range.start);
    const header = headingPath.length > 0 ? `${document.title} > ${headingPath}` : document.title;
    const embedText = `${header}\n\n${slice}`;

    chunks.push({
      id: sha256Hex(`${document.id}:${index}:${document.contentHash}`).slice(0, 32),
      documentId: document.id,
      title: document.title,
      relativePath: document.relativePath,
      headingPath,
      chunkIndex: index,
      charStart: start,
      charEnd: end,
      tokenEstimate: estimateTokens(embedText),
      contentHash: document.contentHash,
      text: slice,
      embedText,
    });
  }

  if (chunks.length === 0) {
    throw new LocalMindError('CHUNKING_FAILED', `Document "${document.relativePath}" produced zero chunks.`, {
      remedy: 'The file is probably whitespace-only after normalisation. Remove it from the corpus.',
      details: { chars: document.charCount },
    });
  }

  return chunks;
}

export interface ChunkCorpusResult {
  readonly chunks: readonly Chunk[];
  readonly stats: {
    readonly documents: number;
    readonly chunks: number;
    readonly meanTokens: number;
    readonly maxTokens: number;
    readonly minTokens: number;
  };
}

export function chunkCorpus(documents: readonly SourceDocument[], options: ChunkOptions): ChunkCorpusResult {
  const chunks = documents.flatMap((document) => chunkDocument(document, options));
  const tokenCounts = chunks.map((chunk) => chunk.tokenEstimate);

  const stats = {
    documents: documents.length,
    chunks: chunks.length,
    meanTokens: tokenCounts.length === 0 ? 0 : Math.round(tokenCounts.reduce((a, b) => a + b, 0) / tokenCounts.length),
    maxTokens: tokenCounts.length === 0 ? 0 : Math.max(...tokenCounts),
    minTokens: tokenCounts.length === 0 ? 0 : Math.min(...tokenCounts),
  };

  log.info('corpus chunked', stats);
  return { chunks, stats };
}
