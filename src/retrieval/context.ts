import { createLogger } from '../core/logger';
import { estimateTokens, truncateToTokens } from '../core/tokens';
import type { Citation, RetrievedChunk } from '../core/types';

/**
 * Context assembly: turning a ranked list of chunks into the exact string that
 * goes into the prompt, plus the citation table that lets us verify the answer
 * afterwards.
 *
 * This module is where three separate failure modes get handled, and it is worth
 * being explicit about them because each one produces a *different* kind of bad
 * answer:
 *
 *  1. CONTEXT DRIFT / LOST-IN-THE-MIDDLE. Dumping 20 chunks in arbitrary order
 *     buries the good evidence. We threshold on score, cap the count, and emit
 *     the strongest evidence first with an explicit relevance score attached so
 *     the model can weigh sources instead of averaging them.
 *
 *  2. OVERLAP DUPLICATION. Chunking with overlap means adjacent chunks share
 *     text verbatim. Concatenating them naively spends budget on duplicated
 *     sentences and — worse — makes a claim look corroborated by two sources
 *     when it appears once. `mergeAdjacent` stitches neighbours and removes the
 *     shared seam.
 *
 *  3. SILENT BUDGET OVERFLOW. If the assembled context exceeds the window, the
 *     provider truncates from one end, usually taking your instructions or your
 *     best source with it. We spend a token budget explicitly and report what
 *     was dropped, so degradation is visible in the trace rather than inferred
 *     from a bad answer.
 */

const log = createLogger('retrieval:context');

export interface ContextBlock {
  readonly label: string;
  readonly chunkId: string;
  readonly title: string;
  readonly relativePath: string;
  readonly headingPath: string;
  readonly score: number;
  readonly text: string;
  readonly tokens: number;
  readonly truncated: boolean;
  /** Chunk ids folded into this block by adjacency merging. */
  readonly mergedFrom: readonly string[];
}

export interface AssembledContext {
  readonly blocks: readonly ContextBlock[];
  readonly citations: readonly Citation[];
  /** The rendered string to inject into the prompt. Empty when nothing survived. */
  readonly contextText: string;
  readonly tokensUsed: number;
  readonly tokenBudget: number;
  readonly droppedChunkIds: readonly string[];
  /** True when a block was truncated or dropped for budget reasons. */
  readonly degraded: boolean;
}

export interface AssembleContextOptions {
  readonly maxTokens: number;
  readonly mergeAdjacent?: boolean;
  /** Minimum share of a block that must fit before we truncate rather than drop. */
  readonly minTruncationRatio?: number;
}

/**
 * Remove the duplicated seam between two overlapping chunks.
 *
 * Finds the longest suffix of `left` that is also a prefix of `right`, searching
 * only the last `maxSeam` characters — the seam can never be longer than the
 * configured chunk overlap, and an unbounded search here would be quadratic on
 * large documents.
 */
export function stitchOverlap(left: string, right: string, maxSeam = 600): string {
  const window = Math.min(maxSeam, left.length, right.length);
  for (let length = window; length >= 24; length -= 1) {
    if (left.endsWith(right.slice(0, length))) {
      return `${left}${right.slice(length)}`;
    }
  }
  return `${left}\n\n${right}`;
}

interface Candidate {
  readonly chunk: RetrievedChunk;
  readonly text: string;
  readonly mergedFrom: readonly string[];
  readonly score: number;
}

/**
 * Fold chunks that are neighbours in the same document into a single candidate.
 * The merged candidate keeps the *highest* score of its parts: it is at least as
 * relevant as its best constituent, and averaging would push genuinely relevant
 * passages below the threshold just because they sit next to a weak one.
 */
function mergeAdjacentChunks(chunks: readonly RetrievedChunk[]): Candidate[] {
  const byDocument = new Map<string, RetrievedChunk[]>();
  for (const chunk of chunks) {
    const bucket = byDocument.get(chunk.documentId);
    if (bucket === undefined) byDocument.set(chunk.documentId, [chunk]);
    else bucket.push(chunk);
  }

  const candidates: Candidate[] = [];

  for (const bucket of byDocument.values()) {
    const ordered = [...bucket].sort((a, b) => a.chunkIndex - b.chunkIndex);

    let current: Candidate | undefined;
    let lastIndex = Number.NaN;

    for (const chunk of ordered) {
      if (current === undefined) {
        current = { chunk, text: chunk.text, mergedFrom: [chunk.id], score: chunk.score };
        lastIndex = chunk.chunkIndex;
        continue;
      }

      if (chunk.chunkIndex === lastIndex + 1) {
        current = {
          // Keep the higher-scoring chunk as the representative for metadata.
          chunk: chunk.score > current.chunk.score ? chunk : current.chunk,
          text: stitchOverlap(current.text, chunk.text),
          mergedFrom: [...current.mergedFrom, chunk.id],
          score: Math.max(current.score, chunk.score),
        };
        lastIndex = chunk.chunkIndex;
        continue;
      }

      candidates.push(current);
      current = { chunk, text: chunk.text, mergedFrom: [chunk.id], score: chunk.score };
      lastIndex = chunk.chunkIndex;
    }

    if (current !== undefined) candidates.push(current);
  }

  return candidates;
}

function renderBlock(block: ContextBlock): string {
  const attributes = [
    `id="${block.label}"`,
    `title="${block.title.replace(/"/gu, "'")}"`,
    `path="${block.relativePath}"`,
    block.headingPath.length > 0 ? `section="${block.headingPath.replace(/"/gu, "'")}"` : '',
    `relevance="${block.score.toFixed(3)}"`,
  ]
    .filter((attribute) => attribute.length > 0)
    .join(' ');

  return `<source ${attributes}>\n${block.text}\n</source>`;
}

/**
 * Build the prompt context from retrieved chunks under a hard token budget.
 */
export function assembleContext(
  chunks: readonly RetrievedChunk[],
  options: AssembleContextOptions,
): AssembledContext {
  const budget = options.maxTokens;
  const minTruncationRatio = options.minTruncationRatio ?? 0.4;

  // 1. De-duplicate. The same chunk can arrive twice when an agent runs several
  //    reformulated queries in one turn — a very common source of wasted budget.
  const seen = new Set<string>();
  const unique: RetrievedChunk[] = [];
  for (const chunk of chunks) {
    if (seen.has(chunk.id)) continue;
    seen.add(chunk.id);
    unique.push(chunk);
  }

  // 2. Optionally stitch neighbours, then rank by score.
  const candidates = (options.mergeAdjacent === false ? unique.map((chunk) => ({
    chunk,
    text: chunk.text,
    mergedFrom: [chunk.id],
    score: chunk.score,
  })) : mergeAdjacentChunks(unique)).sort((a, b) => b.score - a.score);

  // 3. Spend the budget best-first.
  const blocks: ContextBlock[] = [];
  const dropped: string[] = [];
  let used = 0;
  let degraded = false;

  for (const candidate of candidates) {
    const remaining = budget - used;
    if (remaining <= 0) {
      dropped.push(...candidate.mergedFrom);
      degraded = true;
      continue;
    }

    const tokens = estimateTokens(candidate.text);

    if (tokens <= remaining) {
      blocks.push({
        label: `S${blocks.length + 1}`,
        chunkId: candidate.chunk.id,
        title: candidate.chunk.title,
        relativePath: candidate.chunk.relativePath,
        headingPath: candidate.chunk.headingPath,
        score: candidate.score,
        text: candidate.text,
        tokens,
        truncated: false,
        mergedFrom: candidate.mergedFrom,
      });
      used += tokens;
      continue;
    }

    // Partial fit: keep it only if enough of it survives to be useful. A 15%
    // fragment is worse than nothing — it reads as evidence but omits the part
    // that qualifies the claim.
    if (remaining / tokens >= minTruncationRatio) {
      const { text } = truncateToTokens(candidate.text, remaining);
      const actualTokens = estimateTokens(text);
      blocks.push({
        label: `S${blocks.length + 1}`,
        chunkId: candidate.chunk.id,
        title: candidate.chunk.title,
        relativePath: candidate.chunk.relativePath,
        headingPath: candidate.chunk.headingPath,
        score: candidate.score,
        text,
        tokens: actualTokens,
        truncated: true,
        mergedFrom: candidate.mergedFrom,
      });
      used += actualTokens;
      degraded = true;
      continue;
    }

    dropped.push(...candidate.mergedFrom);
    degraded = true;
  }

  const citations: Citation[] = blocks.map((block) => ({
    label: block.label,
    chunkId: block.chunkId,
    title: block.title,
    relativePath: block.relativePath,
    headingPath: block.headingPath,
    score: block.score,
    origin: 'corpus',
  }));

  const contextText = blocks.map(renderBlock).join('\n\n');

  if (degraded) {
    log.warn('context degraded by budget', {
      budget,
      used,
      blocks: blocks.length,
      dropped: dropped.length,
      truncated: blocks.filter((block) => block.truncated).length,
    });
  } else {
    log.debug('context assembled', { budget, used, blocks: blocks.length });
  }

  return {
    blocks,
    citations,
    contextText,
    tokensUsed: used,
    tokenBudget: budget,
    droppedChunkIds: dropped,
    degraded,
  };
}

/** Render web results into the same `<source>` shape so prompts stay uniform. */
export function renderWebSources(
  results: readonly { title: string; url: string; snippet: string }[],
  startIndex: number,
): { text: string; citations: readonly Citation[] } {
  const citations: Citation[] = [];
  const parts: string[] = [];

  for (const [index, result] of results.entries()) {
    const label = `S${startIndex + index}`;
    citations.push({
      label,
      chunkId: `web:${result.url}`,
      title: result.title,
      relativePath: result.url,
      headingPath: '',
      score: 0,
      origin: 'web',
      url: result.url,
    });
    parts.push(
      `<source id="${label}" title="${result.title.replace(/"/gu, "'")}" url="${result.url}" origin="web">\n${result.snippet}\n</source>`,
    );
  }

  return { text: parts.join('\n\n'), citations };
}

/**
 * Post-hoc citation audit.
 *
 * Instructing a model to cite is necessary but not sufficient: it will
 * occasionally invent `[S7]` when only S1-S4 exist, or write a paragraph of
 * fluent, uncited assertion. Checking the output against the citation table is
 * cheap, deterministic, and catches both.
 */
export interface CitationAudit {
  readonly used: readonly string[];
  readonly unknown: readonly string[];
  readonly unused: readonly string[];
  readonly uncitedSentences: readonly string[];
  readonly ok: boolean;
}

/**
 * Bracket pairs a model actually produces around a citation label.
 *
 * The instructions say `[S1]`, and models mostly comply — but not always. A
 * multilingual model will reach for CJK bracket forms mid-sentence, and
 * `nemotron-3-super` emits 【S6】 often enough to matter. Fullwidth ［S1］ and
 * lenticular 〔S1〕 show up for the same reason.
 *
 * This is not cosmetic. `auditCitations` is what decides whether an answer is
 * grounded, and a marker it cannot parse is a marker that does not exist as far
 * as the audit is concerned: every cited claim is reported as *uncited*, the
 * whole citation table comes back *unused*, and Stage 4 then repairs — or
 * refuses — a perfectly well-grounded answer. Normalising the punctuation costs
 * one regex; not doing it silently inverts the verdict the product exists to
 * produce.
 */
const BRACKET_PAIRS: readonly (readonly [string, string])[] = [
  ['\u3010', '\u3011'], // 【 】 CJK black lenticular
  ['\u3014', '\u3015'], // 〔 〕 CJK tortoise shell
  ['\uFF3B', '\uFF3D'], // ［ ］ fullwidth square
  ['\uFF08', '\uFF09'], // （ ） fullwidth parenthesis
  ['\\(', '\\)'], //       ( ) ASCII parenthesis — observed from the free router
];

/**
 * Rewrite every citation marker in a model answer to the canonical `[Sn]`.
 *
 * Two normalisations, in order:
 *
 *   1. Bracket variants -> ASCII square brackets.
 *   2. Compound groups -> separate markers. `[S1, S2]` and `[S1 S2]` are common
 *      and the naive `\[(S\d+)\]` pattern matches *neither*, so a model that
 *      groups its citations reads as having cited nothing at all.
 *
 *   3. Bare labels -> bracketed, but ONLY when `knownLabels` is supplied and
 *      contains the label. Some models drop the brackets entirely and write
 *      "the primary order record table S1." — a form that is unambiguous in
 *      context but indistinguishable from prose without the citation table to
 *      check against. Requiring a known label is what makes this safe: a
 *      sentence mentioning an `S3` bucket in a corpus with two sources is left
 *      alone, because `S3` was never offered as a citation.
 *
 * Idempotent, so it is safe to apply at more than one layer.
 */
export function normaliseCitationMarkers(answer: string, knownLabels?: readonly string[]): string {
  let text = answer;

  for (const [open, close] of BRACKET_PAIRS) {
    // Only rewrite brackets whose contents look like citation labels. A model
    // writing 【note】 in prose is not a citation and must be left alone.
    const pattern = new RegExp(`${open}\\s*(S\\d+(?:\\s*[,;、]\\s*S\\d+)*)\\s*${close}`, 'gu');
    text = text.replace(pattern, (_match, labels: string) => `[${labels}]`);
  }

  // Split `[S1, S2]`, `[S1; S2]`, `[S1 S2]` and `[S1、S2]` into `[S1][S2]`.
  text = text.replace(/\[\s*(S\d+(?:\s*[,;、]?\s+|\s*[,;、]\s*)S\d+(?:\s*[,;、]?\s*S\d+)*)\s*\]/gu, (_match, group: string) => {
    const labels = group.match(/S\d+/gu) ?? [];
    return labels.map((label) => `[${label}]`).join('');
  });

  // Tighten `[ S1 ]` to `[S1]`. Left as-is, the canonical pattern misses it and
  // the bare-label pass wraps the inner label a second time.
  text = text.replace(/\[\s+(S\d+(?:\s*[,;、]\s*S\d+)*)\s+\]/gu, '[$1]');

  // Bare labels, gated on the citation table. Runs last so anything already
  // bracketed by the passes above is skipped by the lookarounds rather than
  // wrapped twice.
  if (knownLabels !== undefined && knownLabels.length > 0) {
    const known = new Set(knownLabels);
    // `[\s*` and `\s*]` in the lookarounds: a model that writes `[ S1 ]` has
    // already bracketed the label, and promoting it again yields `[ [S1] ]` —
    // a chip with stray literal brackets sitting either side of it.
    text = text.replace(/(?<!\[\s{0,3})(?<![\w[])(S\d+)(?![\w\]])(?!\s{0,3}\])/gu, (match, label: string) =>
      known.has(label) ? `[${label}]` : match,
    );
  }

  return text;
}

export function auditCitations(answer: string, citations: readonly Citation[]): CitationAudit {
  const known = new Set(citations.map((citation) => citation.label));
  const used = new Set<string>();
  const unknown = new Set<string>();

  // Normalise first, and pass the citation table so bare labels count too.
  // Auditing the raw string is how a grounded answer gets reported as entirely
  // uncited.
  const normalised = normaliseCitationMarkers(answer, [...known]);

  const pattern = /\[\s*(S\d+)\s*\]/gu;
  let match = pattern.exec(normalised);
  while (match !== null) {
    const label = match[1];
    if (label !== undefined) {
      if (known.has(label)) used.add(label);
      else unknown.add(label);
    }
    match = pattern.exec(normalised);
  }

  // A "claim sentence" is a reasonably long sentence that is not a heading or a
  // list scaffold. Short connective sentences do not need a citation.
  const uncited = normalised
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(
      (sentence) =>
        sentence.length > 80 &&
        !sentence.startsWith('#') &&
        // Markdown table rows are not prose. A schema table renders one long
        // "sentence" per row — `| total_cents | integer | no | ... |` — and
        // counting those as uncited claims made a well-cited answer report six
        // violations it had not committed. The citation belongs to the
        // paragraph introducing the table, not to every cell in it.
        !sentence.trimStart().startsWith('|') &&
        !/\[\s*S\d+\s*\]/u.test(sentence),
    );

  return {
    used: [...used].sort(),
    unknown: [...unknown].sort(),
    unused: [...known].filter((label) => !used.has(label)).sort(),
    uncitedSentences: uncited,
    ok: unknown.size === 0 && uncited.length === 0,
  };
}
