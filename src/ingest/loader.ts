import { extname, join, relative, sep } from 'node:path';

import { LocalMindError } from '../core/errors';
import { inspectPath, listEntries, readTextOrUndefined, sha256Hex } from '../core/fs';
import type { Dirent } from '../core/fs';
import { createLogger } from '../core/logger';
import type { SourceDocument } from '../core/types';

/**
 * Document loading: the least glamorous and most consequential stage.
 *
 * Everything downstream inherits whatever normalisation happens here. Two
 * decisions matter more than they look:
 *
 *  1. Line endings are normalised to `\n` *before* hashing. Without this, the
 *     same file checked out on Windows and Linux produces different content
 *     hashes, so every chunk id changes and re-ingestion duplicates the corpus.
 *  2. Character offsets are computed against the normalised text, so a chunk's
 *     `charStart`/`charEnd` can be used to slice the document again later
 *     (for "show me the surrounding paragraph" style expansion).
 */

const log = createLogger('ingest:loader');

const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.mdx', '.txt', '.markdown']);
const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', '.git', '.data', 'dist']);

/** Hard cap per file. A 10 MB document is almost always a mistake, not a corpus. */
const MAX_FILE_CHARS = 2_000_000;

export interface LoadCorpusOptions {
  readonly corpusDir: string;
  readonly extensions?: ReadonlySet<string>;
}

/**
 * Normalise text so that hashing, offsets and chunk boundaries are stable
 * across platforms and editors.
 */
function normaliseText(raw: string): string {
  return raw
    .replace(/^﻿/u, '') // strip BOM
    .replace(/\r\n?/gu, '\n') // CRLF and lone CR -> LF
    .replace(/[ \t]+$/gmu, '') // trailing whitespace per line
    .replace(/\n{4,}/gu, '\n\n\n') // collapse runaway blank runs
    .trim();
}

/** First markdown H1, else the first non-empty line, else the filename. */
function deriveTitle(text: string, relativePath: string): string {
  const h1 = /^#\s+(.+)$/mu.exec(text);
  if (h1?.[1] !== undefined) return h1[1].trim();

  const firstLine = text.split('\n').find((line) => line.trim().length > 0);
  if (firstLine !== undefined && firstLine.length <= 120) return firstLine.replace(/^#+\s*/u, '').trim();

  return relativePath;
}

/** Stable, filesystem-independent document id. */
function deriveDocumentId(relativePath: string): string {
  return relativePath
    .split(sep)
    .join('/')
    .replace(/\.[^.]+$/u, '')
    .replace(/[^a-zA-Z0-9/_-]+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^-|-$/gu, '')
    .toLowerCase();
}

/**
 * Build a `SourceDocument` from text you already have.
 *
 * This is the integration seam for anything that is not a file on disk: database
 * rows, a CMS API, scraped HTML, extracted PDF text, Slack threads. It applies
 * exactly the same normalisation and hashing as the file loader, which is what
 * keeps chunk ids stable and re-ingestion idempotent for custom sources too.
 *
 * `sourcePath` is a display/citation identifier, not a filesystem path — a URL,
 * a table name plus primary key, or a ticket id are all fine. It is what appears
 * in citations, so make it something a reader can act on.
 */
export function createSourceDocument(input: {
  readonly id: string;
  readonly text: string;
  readonly title?: string;
  readonly sourcePath?: string;
}): SourceDocument {
  const text = normaliseText(input.text);
  if (text.length === 0) {
    throw new LocalMindError('CORPUS_UNREADABLE', `Document "${input.id}" is empty after normalisation.`, {
      remedy: 'Filter empty records out before ingesting; an empty document produces zero chunks.',
      details: { id: input.id },
    });
  }

  const sourcePath = input.sourcePath ?? input.id;
  return {
    id: input.id,
    title: input.title ?? deriveTitle(text, sourcePath),
    relativePath: sourcePath,
    absolutePath: sourcePath,
    text,
    charCount: text.length,
    contentHash: sha256Hex(text),
  };
}

/**
 * Reject duplicate ids in a hand-built document set.
 *
 * The file loader gets this for free from the filesystem. A custom source does
 * not: two rows mapping to the same id would silently overwrite each other via
 * merge-insert, and you would lose documents without any error.
 */
export function assertUniqueDocumentIds(documents: readonly SourceDocument[]): void {
  const seen = new Map<string, string>();
  for (const document of documents) {
    const previous = seen.get(document.id);
    if (previous !== undefined) {
      throw new LocalMindError('CORPUS_UNREADABLE', `Duplicate document id "${document.id}".`, {
        remedy: 'Document ids must be unique: chunk ids derive from them, so duplicates overwrite each other on upsert.',
        details: { id: document.id, first: previous, second: document.relativePath },
      });
    }
    seen.set(document.id, document.relativePath);
  }
}

async function walk(dir: string, root: string, extensions: ReadonlySet<string>): Promise<string[]> {
  const entries: Dirent[] = await listEntries(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
      files.push(...(await walk(absolute, root, extensions)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!extensions.has(extname(entry.name).toLowerCase())) continue;
    files.push(absolute);
  }

  return files.sort();
}

/**
 * Read every supported file under `corpusDir` into a normalised
 * `SourceDocument`. Sorted output makes ingestion deterministic, which matters
 * for reproducible chunk ids.
 */
export async function loadCorpus(options: LoadCorpusOptions): Promise<readonly SourceDocument[]> {
  const { corpusDir } = options;
  const extensions = options.extensions ?? SUPPORTED_EXTENSIONS;

  const corpusInfo = await inspectPath(corpusDir);
  if (!corpusInfo.exists) {
    throw new LocalMindError('CORPUS_UNREADABLE', `Cannot read corpus directory "${corpusDir}".`, {
      remedy: 'Create the directory and add at least one .md or .txt file, or set LOCALMIND_CORPUS_DIR.',
    });
  }
  if (!corpusInfo.isDirectory) {
    throw new LocalMindError('CORPUS_UNREADABLE', `Corpus path "${corpusDir}" is not a directory.`, {
      remedy: 'Point LOCALMIND_CORPUS_DIR at a directory of .md / .txt files.',
    });
  }

  const paths = await walk(corpusDir, corpusDir, extensions);
  const documents: SourceDocument[] = [];
  const seenIds = new Map<string, string>();

  for (const absolutePath of paths) {
    const raw = await readTextOrUndefined(absolutePath);
    if (raw === undefined) {
      log.warn('skipping unreadable file', { path: absolutePath });
      continue;
    }

    if (raw.length > MAX_FILE_CHARS) {
      log.warn('skipping oversized file', { path: absolutePath, chars: raw.length, limit: MAX_FILE_CHARS });
      continue;
    }

    const text = normaliseText(raw);
    if (text.length === 0) {
      log.debug('skipping empty file', { path: absolutePath });
      continue;
    }

    const relativePath = relative(corpusDir, absolutePath).split(sep).join('/');
    const id = deriveDocumentId(relativePath);

    const collision = seenIds.get(id);
    if (collision !== undefined) {
      throw new LocalMindError(
        'CORPUS_UNREADABLE',
        `Documents "${collision}" and "${relativePath}" both slugify to the id "${id}".`,
        {
          remedy: 'Rename one of the files. Document ids must be unique because chunk ids are derived from them.',
          details: { id },
        },
      );
    }
    seenIds.set(id, relativePath);

    documents.push({
      id,
      title: deriveTitle(text, relativePath),
      relativePath,
      absolutePath,
      text,
      charCount: text.length,
      contentHash: sha256Hex(text),
    });
  }

  if (documents.length === 0) {
    throw new LocalMindError('CORPUS_EMPTY', `No supported documents found under "${corpusDir}".`, {
      remedy: `Add at least one file with an extension in {${[...extensions].join(', ')}}.`,
    });
  }

  log.info('corpus loaded', {
    documents: documents.length,
    chars: documents.reduce((sum, doc) => sum + doc.charCount, 0),
  });

  return documents;
}
