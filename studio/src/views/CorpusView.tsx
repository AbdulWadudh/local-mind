import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Boxes,
  Database,
  FileText,
  GitBranch,
  Hash,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Wand2,
} from 'lucide-react';

import type { CorpusDocumentSummary, CorpusListResponse, DocumentOrigin } from '@localmind/protocol';

import { api, ApiError } from '../lib/api';
import { cn } from '../lib/cn';
import {
  Badge,
  Button,
  Checkbox,
  Empty,
  ErrorNote,
  Field,
  Input,
  Modal,
  Panel,
  SkeletonRows,
  Stat,
  TableScroll,
  Textarea,
} from '../components/ui';

/**
 * The corpus view: add, edit, delete and re-index documents.
 *
 * THREE DESIGN POINTS WORTH DEFENDING
 *
 * 1. The list sends summaries, not bodies. A corpus that has ingested a
 *    repository is hundreds of documents, some tens of kilobytes; fetching every
 *    body to render a list makes the page slow for no benefit. The editor
 *    fetches one full document on open.
 *
 * 2. Bulk selection with a contextual action bar, and select-all at two levels:
 *    everything currently listed, or one source group. Both respect the active
 *    filter — "select all" means "all 12 rows you can see", never "all 400 rows
 *    in the corpus", because a selection that silently exceeds what is on screen
 *    is how people delete things they did not mean to. Deleting forty repository
 *    documents one row at a time is the kind of tedium that makes an admin UI
 *    feel unfinished.
 *
 * 3. Editing is honest about cost. Changing the *text* re-chunks and re-embeds
 *    (seconds on a local CPU model); changing only the title or tags does not.
 *    The save result says which happened, because a user who does not know that
 *    will assume the tool is randomly slow.
 */

const ORIGIN_META: Record<DocumentOrigin, { label: string; icon: ReactNode; tone: 'neutral' | 'info' | 'accent' }> = {
  manual: { label: 'manual', icon: <Pencil className="size-2.5" aria-hidden />, tone: 'neutral' },
  file: { label: 'file', icon: <FileText className="size-2.5" aria-hidden />, tone: 'neutral' },
  github: { label: 'github', icon: <GitBranch className="size-2.5" aria-hidden />, tone: 'info' },
  service: { label: 'service', icon: <Database className="size-2.5" aria-hidden />, tone: 'accent' },
  api: { label: 'api', icon: <Boxes className="size-2.5" aria-hidden />, tone: 'accent' },
};

const FALLBACK_ORIGIN = { label: 'unknown', icon: null, tone: 'neutral' as const };

function originMeta(origin: DocumentOrigin): { label: string; icon: ReactNode; tone: 'neutral' | 'info' | 'accent' } {
  return ORIGIN_META[origin] ?? FALLBACK_ORIGIN;
}

interface EditorState {
  readonly id?: string;
  title: string;
  text: string;
  sourcePath: string;
  tags: string;
}

const EMPTY_EDITOR: EditorState = { title: '', text: '', sourcePath: '', tags: '' };

export function CorpusView({ onCorpusChanged }: { onCorpusChanged: () => void }): ReactNode {
  const [data, setData] = useState<CorpusListResponse | null>(null);
  const [search, setSearch] = useState('');
  const [originFilter, setOriginFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code: string; message: string; remedy: string } | null>(null);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorNote, setEditorNote] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CorpusDocumentSummary[] | null>(null);
  const [reindexing, setReindexing] = useState<{ done: number; total: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(
        await api.corpus.list({
          ...(search.length > 0 ? { search } : {}),
          ...(originFilter.length > 0 ? { origin: originFilter } : {}),
          limit: 500,
        }),
      );
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? { code: caught.code, message: caught.message, remedy: caught.remedy }
          : { code: 'NETWORK', message: String(caught), remedy: 'Is the API process running?' },
      );
    } finally {
      setLoading(false);
    }
  }, [search, originFilter]);

  // Debounced, so typing in the filter does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => void load(), 200);
    return () => clearTimeout(timer);
  }, [load]);

  const openEditor = useCallback(async (document?: CorpusDocumentSummary) => {
    setEditorNote(null);
    if (document === undefined) {
      setEditor({ ...EMPTY_EDITOR });
      return;
    }
    setEditor({ ...EMPTY_EDITOR, id: document.id, title: document.title });
    setEditorBusy(true);
    try {
      const full = await api.corpus.get(document.id);
      setEditor({
        id: full.id,
        title: full.title,
        text: full.text,
        sourcePath: full.sourcePath,
        tags: full.tags.join(', '),
      });
    } finally {
      setEditorBusy(false);
    }
  }, []);

  const save = useCallback(async () => {
    if (editor === null) return;
    setEditorBusy(true);
    setEditorNote(null);
    try {
      const body = {
        title: editor.title.trim(),
        text: editor.text,
        ...(editor.sourcePath.trim().length > 0 ? { sourcePath: editor.sourcePath.trim() } : {}),
        tags: editor.tags
          .split(',')
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0),
      };

      const result = editor.id === undefined ? await api.corpus.create(body) : await api.corpus.update(editor.id, body);

      setEditorNote(
        result.reembedded
          ? `Saved — re-embedded into ${result.chunksWritten} chunk(s)` +
              (result.chunksRemoved > 0 ? `, replacing ${result.chunksRemoved}.` : '.')
          : 'Saved — text unchanged, so no re-embedding was needed.',
      );
      setEditor((previous) => (previous === null ? null : { ...previous, id: result.document.id }));
      await load();
      onCorpusChanged();
    } catch (caught) {
      setEditorNote(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught));
    } finally {
      setEditorBusy(false);
    }
  }, [editor, load, onCorpusChanged]);

  const confirmDelete = useCallback(async () => {
    if (pendingDelete === null) return;
    for (const document of pendingDelete) await api.corpus.remove(document.id);
    setPendingDelete(null);
    setSelected(new Set());
    await load();
    onCorpusChanged();
  }, [pendingDelete, load, onCorpusChanged]);

  const reindex = useCallback(async () => {
    setReindexing({ done: 0, total: 0 });
    try {
      for await (const event of api.corpus.reindex()) {
        if (event.type === 'progress') setReindexing({ done: event.done ?? 0, total: event.total ?? 0 });
        if (event.type === 'error') setError({ code: event.code, message: event.message, remedy: event.remedy });
      }
      await load();
      onCorpusChanged();
    } finally {
      setReindexing(null);
    }
  }, [load, onCorpusChanged]);

  const documents = data?.documents ?? [];

  const grouped = useMemo(() => {
    const bySource = new Map<string, CorpusDocumentSummary[]>();
    for (const document of documents) {
      const key = document.sourceRef.length > 0 ? document.sourceRef : 'standalone';
      const list = bySource.get(key) ?? [];
      list.push(document);
      bySource.set(key, list);
    }
    return [...bySource.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [documents]);

  const toggle = (id: string): void => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /**
   * Toggle a whole group of rows.
   *
   * "All of these are selected" is the condition for clearing, not "some are".
   * The alternative — clear whenever anything is selected — makes the header
   * checkbox destroy a partial selection the user built by hand, which is the
   * single most annoying way to get a tri-state checkbox wrong.
   */
  const toggleMany = (ids: readonly string[]): void => {
    setSelected((previous) => {
      const next = new Set(previous);
      const allSelected = ids.length > 0 && ids.every((id) => next.has(id));
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const stats = data?.stats;
  const selectedDocuments = documents.filter((document) => selected.has(document.id));
  const visibleIds = documents.map((document) => document.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someVisibleSelected = visibleIds.some((id) => selected.has(id));
  const filtered = search.length > 0 || originFilter.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* ── stats + actions ─────────────────────────────────────────────── */}
      <div className="grid shrink-0 grid-cols-2 items-end gap-3 rounded-panel border border-line-soft bg-surface p-3 sm:grid-cols-5">
        {/*
          `loading` rather than a placeholder dash. A row of em-dashes is
          indistinguishable from a corpus of genuine zeroes, so a request that
          has not answered yet — or an API that is down — reads as "your corpus
          is empty" instead of "we do not know yet".
        */}
        <Stat label="documents" value={stats?.documents ?? '—'} loading={stats === undefined && loading} />
        <Stat label="chunks" value={stats?.chunks ?? '—'} loading={stats === undefined && loading} />
        <Stat label="dimensions" value={stats?.dimensions ?? '—'} loading={stats === undefined && loading} />
        <Stat
          label="embedding model"
          value={stats?.embeddingModel ?? '—'}
          loading={stats === undefined && loading}
          title={stats?.embeddingModel}
        />
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void reindex()}
            loading={reindexing !== null}
            title="Re-chunk and re-embed every document. Needed after changing chunk settings."
          >
            <RefreshCw className="size-3.5" aria-hidden />
            {reindexing !== null ? `${reindexing.done}/${reindexing.total}` : 'Reindex'}
          </Button>
          <Button variant="primary" size="sm" onClick={() => void openEditor()}>
            <Plus className="size-3.5" aria-hidden />
            New
          </Button>
        </div>
      </div>

      {/* ── filters ─────────────────────────────────────────────────────── */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          {/* Decorative: the field has a real <label> and a placeholder, so the
              glyph carries no information and may sit at the dimmest tier. */}
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
          <label className="sr-only" htmlFor="lm-corpus-filter">
            Filter documents
          </label>
          <Input
            id="lm-corpus-filter"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter by title, path or tag…"
            className="pl-8"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          <FilterChip active={originFilter === ''} onClick={() => setOriginFilter('')} label="all" />
          {(Object.keys(ORIGIN_META) as DocumentOrigin[]).map((origin) => {
            const count = stats?.byOrigin[origin] ?? 0;
            if (count === 0 && originFilter !== origin) return null;
            return (
              <FilterChip
                key={origin}
                active={originFilter === origin}
                onClick={() => setOriginFilter(origin)}
                label={`${originMeta(origin).label} ${count}`}
              />
            );
          })}
        </div>
      </div>

      {error !== null ? <ErrorNote code={error.code} message={error.message} remedy={error.remedy} /> : null}

      {/* ── bulk action bar: appears only when a selection exists ───────── */}
      {selected.size > 0 ? (
        <div className="lm-enter flex shrink-0 flex-wrap items-center gap-3 rounded-control border border-accent/35 bg-accent/8 px-3 py-2">
          <Badge tone="accent">{selected.size} selected</Badge>
          <Button variant="ghost" size="sm" onClick={() => toggleMany(visibleIds)} disabled={allVisibleSelected}>
            Select all {visibleIds.length}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
          {/* Named explicitly when a filter is on, so "select all" can never be
              mistaken for the whole corpus. */}
          {filtered ? <span className="text-xs text-muted">of the filtered list</span> : null}
          <div className="flex-1" />
          <Button variant="danger" size="sm" onClick={() => setPendingDelete(selectedDocuments)}>
            <Trash2 className="size-3.5" aria-hidden />
            Delete {selected.size}
          </Button>
        </div>
      ) : null}

      {/* ── list ────────────────────────────────────────────────────────── */}
      <Panel className="min-h-0 flex-1" bodyClassName="p-0" busy={loading}>
        {loading && data === null ? (
          <div className="p-3.5">
            <SkeletonRows rows={7} />
          </div>
        ) : documents.length === 0 ? (
          <Empty
            icon={<FileText className="size-8" />}
            title="No documents"
            hint="Create one here, or ingest a repository or a service schema from the Sources tab."
            action={
              <Button variant="primary" size="sm" onClick={() => void openEditor()}>
                <Plus className="size-3.5" aria-hidden />
                New document
              </Button>
            }
          />
        ) : (
          <TableScroll>
            <div className="min-w-[42rem] divide-y divide-line-soft">
              {/* Select-all for everything currently listed. Tri-state, so a
                  partial selection is visible rather than reading as empty. */}
              <div className="flex items-center gap-3 bg-inset/40 px-3.5 py-2">
                <Checkbox
                  checked={allVisibleSelected}
                  indeterminate={someVisibleSelected}
                  onChange={() => toggleMany(visibleIds)}
                  label={allVisibleSelected ? 'Clear selection' : `Select all ${visibleIds.length} listed documents`}
                />
                <span className="font-mono text-[11px] uppercase tracking-wider text-muted">
                  {selected.size > 0 ? `${selected.size} of ${documents.length} selected` : `${documents.length} documents`}
                  {filtered ? ' · filtered' : ''}
                </span>
              </div>

              {grouped.map(([sourceRef, group]) => (
                <div key={sourceRef}>
                  {sourceRef !== 'standalone' ? (
                    <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-line-soft bg-surface/95 px-3.5 py-1.5 backdrop-blur">
                      <Checkbox
                        checked={group.every((document) => selected.has(document.id))}
                        indeterminate={group.some((document) => selected.has(document.id))}
                        onChange={() => toggleMany(group.map((document) => document.id))}
                        label={`Select all ${group.length} documents from ${sourceRef}`}
                      />
                      <span className="lm-wrap-any min-w-0 flex-1 truncate font-mono text-[11px] text-muted">
                        {sourceRef}
                      </span>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge>{group.length} docs</Badge>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Remove every document from ${sourceRef}`}
                          onClick={async () => {
                            await api.corpus.removeSource(sourceRef);
                            await load();
                            onCorpusChanged();
                          }}
                        >
                          <Trash2 className="size-3" aria-hidden />
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-line-soft bg-surface/95 px-3.5 py-1.5 backdrop-blur">
                      <Checkbox
                        checked={group.every((document) => selected.has(document.id))}
                        indeterminate={group.some((document) => selected.has(document.id))}
                        onChange={() => toggleMany(group.map((document) => document.id))}
                        label={`Select all ${group.length} standalone documents`}
                      />
                      <span className="min-w-0 flex-1 font-mono text-[11px] text-muted">
                        standalone — added here or loaded from files
                      </span>
                      <Badge>{group.length} docs</Badge>
                    </div>
                  )}

                  {group.map((document) => {
                    const meta = originMeta(document.origin);
                    const isSelected = selected.has(document.id);
                    return (
                      <div
                        key={document.id}
                        className={cn(
                          'group flex items-center gap-3 px-3.5 py-2.5 transition-colors duration-200',
                          isSelected ? 'bg-accent/6' : 'hover:bg-inset/50',
                        )}
                      >
                        <Checkbox
                          checked={isSelected}
                          onChange={() => toggle(document.id)}
                          label={`Select ${document.title}`}
                        />

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <Badge tone={meta.tone}>
                              {meta.icon}
                              {meta.label}
                            </Badge>
                            <span className="truncate text-sm font-medium text-fg">{document.title}</span>
                          </div>
                          <div className="mt-0.5 flex items-center gap-3 truncate font-mono text-[10px] tnum text-muted">
                            <span className="truncate">{document.sourcePath}</span>
                            <span className="flex shrink-0 items-center gap-1">
                              <Hash className="size-2.5" aria-hidden />
                              {document.chunkCount}
                            </span>
                            <span className="shrink-0">{(document.charCount / 1000).toFixed(1)}k chars</span>
                          </div>
                        </div>

                        {document.tags.length > 0 ? (
                          <div className="hidden shrink-0 gap-1 xl:flex">
                            {document.tags.slice(0, 3).map((tag) => (
                              <Badge key={tag} mono={false}>
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        ) : null}

                        {/*
                          Row actions stay in the DOM and only change opacity, so
                          they are keyboard-reachable — a hover-only affordance is
                          unreachable without a pointer.
                        */}
                        <div className="flex shrink-0 gap-1 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => void openEditor(document)}
                            aria-label={`Edit ${document.title}`}
                          >
                            <Pencil className="size-3.5" aria-hidden />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setPendingDelete([document])}
                            aria-label={`Delete ${document.title}`}
                          >
                            <Trash2 className="size-3.5" aria-hidden />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </TableScroll>
        )}
      </Panel>

      {/* ── editor ──────────────────────────────────────────────────────── */}
      <Modal
        open={editor !== null}
        wide
        title={editor?.id === undefined ? 'New document' : `Edit — ${editor.id}`}
        onClose={() => setEditor(null)}
        footer={
          <>
            {editorNote !== null ? (
              <p role="status" className="mr-auto text-xs text-muted">
                {editorNote}
              </p>
            ) : null}
            <Button variant="ghost" onClick={() => setEditor(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={editorBusy}
              disabled={editor === null || editor.title.trim().length === 0 || editor.text.trim().length === 0}
              onClick={() => void save()}
            >
              <Wand2 className="size-3.5" aria-hidden />
              Save &amp; embed
            </Button>
          </>
        }
      >
        {editor !== null ? (
          <div className="space-y-3.5">
            <div className="grid gap-3.5 sm:grid-cols-2">
              <Field label="Title" required>
                {(field) => (
                  <Input
                    {...field}
                    value={editor.title}
                    onChange={(event) => setEditor({ ...editor, title: event.target.value })}
                    placeholder="Refund policy"
                  />
                )}
              </Field>
              <Field
                label="Source path"
                hint="Shown in citations. A URL, a file path, or table/pk — something a reader can act on."
              >
                {(field) => (
                  <Input
                    {...field}
                    value={editor.sourcePath}
                    onChange={(event) => setEditor({ ...editor, sourcePath: event.target.value })}
                    placeholder="https://wiki.internal/refunds"
                  />
                )}
              </Field>
            </div>

            <Field label="Tags" hint="Comma separated. Used for filtering only; they are not embedded.">
              {(field) => (
                <Input
                  {...field}
                  value={editor.tags}
                  onChange={(event) => setEditor({ ...editor, tags: event.target.value })}
                  placeholder="policy, billing"
                />
              )}
            </Field>

            <Field
              label="Content"
              required
              hint="Markdown. Headings become the retrieval breadcrumb, so structure genuinely improves recall."
            >
              {(field) => (
                <Textarea
                  {...field}
                  value={editor.text}
                  onChange={(event) => setEditor({ ...editor, text: event.target.value })}
                  rows={16}
                  className="font-mono text-[13px]"
                  placeholder={'# Refund policy\n\nRefunds are accepted within 30 days of delivery.'}
                />
              )}
            </Field>

            <p className="text-xs leading-relaxed text-muted">
              Saving chunks this text at your configured size, embeds every chunk, and replaces any previous chunks for
              this document. Editing only the title or tags skips re-embedding.
            </p>
          </div>
        ) : null}
      </Modal>

      {/* ── delete confirmation ─────────────────────────────────────────── */}
      <Modal
        open={pendingDelete !== null}
        title={pendingDelete !== null && pendingDelete.length > 1 ? `Delete ${pendingDelete.length} documents` : 'Delete document'}
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void confirmDelete()}>
              <Trash2 className="size-3.5" aria-hidden />
              Delete
            </Button>
          </>
        }
      >
        {pendingDelete !== null ? (
          <>
            <p className="text-sm text-fg">
              Delete {pendingDelete.length === 1 ? (
                <span className="font-medium">{pendingDelete[0]?.title}</span>
              ) : (
                <span className="font-medium">{pendingDelete.length} documents</span>
              )}{' '}
              and their{' '}
              <span className="font-mono tnum">
                {pendingDelete.reduce((sum, document) => sum + document.chunkCount, 0)}
              </span>{' '}
              chunk(s)?
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted">
              This removes the documents and their vectors immediately. Anything that came from a source run will
              reappear the next time that source is ingested.
            </p>
          </>
        ) : null}
      </Modal>
    </div>
  );
}

function FilterChip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }): ReactNode {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'cursor-pointer rounded-control border px-2 py-1 font-mono text-[11px] tnum transition-colors duration-200',
        active ? 'border-accent/50 bg-accent/12 text-accent' : 'border-line-soft text-muted hover:border-line hover:text-fg',
      )}
    >
      {label}
    </button>
  );
}
