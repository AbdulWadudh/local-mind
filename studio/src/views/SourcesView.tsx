import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Database,
  Download,
  FileSearch,
  GitBranch,
  Info,
  Plug,
  ScanSearch,
  ShieldAlert,
} from 'lucide-react';

import type {
  AnalyzePreview,
  ConnectorDescriptor,
  DetectedService,
  IngestSummary,
} from '@localmind/protocol';

import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { Badge, Button, Checkbox, Empty, ErrorNote, Field, Input, Modal, Panel, Spinner, Stat } from '../components/ui';

/**
 * The sources view: point LocalMind at a repository, then at the services that
 * repository actually uses.
 *
 * THE FLOW THIS UI EXISTS TO MAKE OBVIOUS
 *
 *   1. Analyse a repo   — clone, read, detect. Writes nothing.
 *   2. Review           — see the documents that *would* be created, and the
 *                         services that were detected with the evidence for each.
 *   3. Ingest           — commit those documents to the corpus.
 *   4. Connect services — for each detected service, fill in the credential and
 *                         ingest its live schema.
 *
 * Step 1 being a dry run is the important part. Ingesting a source *replaces*
 * everything the previous run of that source produced, so showing the user what
 * they are about to commit — before committing it — is the difference between a
 * tool you trust with your corpus and one you do not.
 *
 * The preview is also a SELECTION, not just a report. A repository analysis
 * routinely produces a couple of documents nobody wants indexed — a vendored
 * fixture, a generated lockfile summary — and the alternative to unchecking them
 * here is ingesting all of them and then deleting them from the Corpus tab,
 * which costs an embedding pass for text that was never wanted.
 */

interface ProgressState {
  readonly stage: string;
  readonly detail?: string;
  readonly done?: number;
  readonly total?: number;
}

type Failure = { code: string; message: string; remedy: string };

export function SourcesView({
  connectors,
  onCorpusChanged,
}: {
  connectors: readonly ConnectorDescriptor[];
  onCorpusChanged: () => void;
}): ReactNode {
  /* ── repository analysis ───────────────────────────────────────────────── */
  const [repo, setRepo] = useState('');
  const [ref, setRef] = useState('');
  const [token, setToken] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [skipSynthesis, setSkipSynthesis] = useState(false);

  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [preview, setPreview] = useState<AnalyzePreview | null>(null);
  const [summary, setSummary] = useState<IngestSummary | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState<'analyze' | 'ingest' | null>(null);

  /**
   * Which preview documents to write. `null` means "not narrowed" — every
   * document, including any the next analysis discovers.
   *
   * A null default rather than a set pre-filled with every id, because the two
   * differ the moment a re-analysis returns a document the previous run did not
   * have: a pre-filled set would silently exclude it.
   */
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());

  /* ── connector modal ───────────────────────────────────────────────────── */
  const [connector, setConnector] = useState<ConnectorDescriptor | null>(null);
  const [form, setForm] = useState<Record<string, string | boolean>>({});
  const [connectorBusy, setConnectorBusy] = useState(false);
  const [connectorResult, setConnectorResult] = useState<IngestSummary | null>(null);
  const [connectorFailure, setConnectorFailure] = useState<Failure | null>(null);
  const [connectorProgress, setConnectorProgress] = useState<ProgressState | null>(null);

  const analyze = useCallback(async () => {
    setBusy('analyze');
    setFailure(null);
    setPreview(null);
    setSummary(null);
    setProgress({ stage: 'starting' });

    try {
      for await (const event of api.analyzeRepo({
        ...(repo.trim().length > 0 ? { repo: repo.trim() } : {}),
        ...(localPath.trim().length > 0 ? { path: localPath.trim() } : {}),
        ...(ref.trim().length > 0 ? { ref: ref.trim() } : {}),
        ...(token.trim().length > 0 ? { token: token.trim() } : {}),
        ...(skipSynthesis ? { skipSynthesis: true } : {}),
      })) {
        if (event.type === 'progress') {
          setProgress({
            stage: event.stage,
            ...(event.detail !== undefined ? { detail: event.detail } : {}),
            ...(event.done !== undefined ? { done: event.done } : {}),
            ...(event.total !== undefined ? { total: event.total } : {}),
          });
        }
        if (event.type === 'preview') {
          setPreview(event.preview);
          // Ids are only meaningful for the preview that produced them, so a
          // stale exclusion set must not survive a re-analysis.
          setExcluded(new Set());
        }
        if (event.type === 'error') setFailure(event);
      }
    } catch (error) {
      setFailure({ code: 'NETWORK', message: String(error), remedy: 'Is the API process running?' });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, [repo, localPath, ref, token, skipSynthesis]);

  const ingestRepo = useCallback(async () => {
    setBusy('ingest');
    setFailure(null);
    setProgress({ stage: 'starting' });

    try {
      // `include` is only sent when the user actually narrowed the set. Sending
      // the full id list every time would turn "Analyse & ingest" — which has no
      // preview and therefore no ids — into a request that matches nothing.
      const include =
        preview !== null && excluded.size > 0
          ? preview.documents.filter((document) => !excluded.has(document.id)).map((document) => document.id)
          : undefined;

      for await (const event of api.ingestSource({
        kind: 'github',
        config: {
          ...(repo.trim().length > 0 ? { repo: repo.trim() } : {}),
          ...(localPath.trim().length > 0 ? { path: localPath.trim() } : {}),
          ...(ref.trim().length > 0 ? { ref: ref.trim() } : {}),
          ...(token.trim().length > 0 ? { token: token.trim() } : {}),
          ...(skipSynthesis ? { skipSynthesis: true } : {}),
        },
        ...(include !== undefined ? { include } : {}),
      })) {
        if (event.type === 'progress') {
          setProgress({
            stage: event.stage,
            ...(event.detail !== undefined ? { detail: event.detail } : {}),
            ...(event.done !== undefined ? { done: event.done } : {}),
            ...(event.total !== undefined ? { total: event.total } : {}),
          });
        }
        if (event.type === 'ingested') {
          setSummary(event.summary);
          onCorpusChanged();
        }
        if (event.type === 'error') setFailure(event);
      }
    } catch (error) {
      setFailure({ code: 'NETWORK', message: String(error), remedy: 'Is the API process running?' });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, [repo, localPath, ref, token, skipSynthesis, onCorpusChanged, preview, excluded]);

  const openConnector = useCallback((descriptor: ConnectorDescriptor, detected?: DetectedService) => {
    setConnector(descriptor);
    setConnectorResult(null);
    setConnectorFailure(null);
    setConnectorProgress(null);

    // Seed the form with anything we can infer. Env var *names* from detection
    // are a hint for the user, never a value we can read from the browser.
    const seed: Record<string, string | boolean> = {};
    for (const field of descriptor.fields) {
      seed[field.name] = field.type === 'boolean' ? false : '';
    }
    if (detected !== undefined && detected.envVars.length > 0) {
      const urlField = descriptor.fields.find((field) => field.name === 'url' || field.name === 'node');
      if (urlField !== undefined) seed[`__hint_${urlField.name}`] = detected.envVars.join(', ');
    }
    setForm(seed);
  }, []);

  const runConnector = useCallback(async () => {
    if (connector === null) return;
    setConnectorBusy(true);
    setConnectorFailure(null);
    setConnectorResult(null);

    const config: Record<string, unknown> = {};
    for (const field of connector.fields) {
      const value = form[field.name];
      if (value === undefined || value === '' || value === false) continue;
      config[field.name] = value;
    }

    try {
      for await (const event of api.ingestSource({ kind: connector.kind, config })) {
        if (event.type === 'progress') {
          setConnectorProgress({
            stage: event.stage,
            ...(event.detail !== undefined ? { detail: event.detail } : {}),
            ...(event.done !== undefined ? { done: event.done } : {}),
            ...(event.total !== undefined ? { total: event.total } : {}),
          });
        }
        if (event.type === 'ingested') {
          setConnectorResult(event.summary);
          onCorpusChanged();
        }
        if (event.type === 'error') setConnectorFailure(event);
      }
    } catch (error) {
      setConnectorFailure({ code: 'NETWORK', message: String(error), remedy: 'Is the API process running?' });
    } finally {
      setConnectorBusy(false);
      setConnectorProgress(null);
    }
  }, [connector, form, onCorpusChanged]);

  const canAnalyze = repo.trim().length > 0 || localPath.trim().length > 0;
  const detected = preview?.detectedServices ?? summary?.detectedServices ?? [];

  const previewDocuments = preview?.documents ?? [];
  const selectedCount = previewDocuments.length - excluded.size;
  const allSelected = excluded.size === 0;
  const noneSelected = selectedCount === 0;

  const toggleDocument = (id: string): void => {
    setExcluded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Select-all clears the exclusions; the inverse selects nothing, which is
  // deliberately reachable so the ingest button can explain why it is disabled
  // rather than the user wondering where their documents went.
  const toggleAllDocuments = (): void => {
    setExcluded(allSelected ? new Set(previewDocuments.map((document) => document.id)) : new Set());
  };

  return (
    <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
      {/* ── left: repository ──────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-col gap-3">
        <Panel
          title={
            <span className="flex items-center gap-1.5">
              <GitBranch className="size-3.5" />
              Analyse a repository
            </span>
          }
        >
          <div className="space-y-3.5">
            <div className="grid gap-3.5 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <Field label="Repository" hint="owner/name, a GitHub URL, or an SSH remote.">
                {(bound) => (
                  <Input
                    {...bound}
                    value={repo}
                    onChange={(event) => setRepo(event.target.value)}
                    placeholder="vercel/ai"
                    disabled={localPath.trim().length > 0}
                  />
                )}
              </Field>
              <Field label="Branch or tag" hint="Defaults to the default branch.">
                {(bound) => (
                  <Input {...bound} value={ref} onChange={(event) => setRef(event.target.value)} placeholder="main" />
                )}
              </Field>
            </div>

            <div className="grid gap-3.5 sm:grid-cols-2">
              <Field label="…or a local checkout" hint="Nothing is cloned and nothing is deleted.">
                {(bound) => (
                  <Input
                    {...bound}
                    value={localPath}
                    onChange={(event) => setLocalPath(event.target.value)}
                    placeholder="../my-service"
                  />
                )}
              </Field>
              <Field label="Access token" hint="Private repos only. Used for the clone, never stored.">
                {(bound) => (
                  <Input
                    {...bound}
                    type="password"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    placeholder="ghp_…"
                  />
                )}
              </Field>
            </div>

            <label className="flex cursor-pointer items-start gap-2 rounded-control border border-line-soft bg-inset/40 p-2.5">
              <input
                type="checkbox"
                checked={skipSynthesis}
                onChange={(event) => setSkipSynthesis(event.target.checked)}
                className="mt-0.5 accent-[var(--color-accent)]"
              />
              <span className="text-xs leading-snug text-muted">
                <span className="font-medium text-fg">Skip architecture synthesis</span> — structure, dependency,
                configuration and service documents are still produced, at zero model cost. Only the model-written
                overview and data-flow documents are skipped.
              </span>
            </label>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                onClick={() => void analyze()}
                disabled={!canAnalyze || busy !== null}
                loading={busy === 'analyze'}
              >
                <ScanSearch className="size-4" />
                Analyse
              </Button>
              <Button
                variant="outline"
                onClick={() => void ingestRepo()}
                disabled={!canAnalyze || busy !== null}
                loading={busy === 'ingest'}
              >
                <Download className="size-4" />
                Analyse &amp; ingest
              </Button>
              {progress !== null ? (
                <span className="flex items-center gap-2 text-xs text-muted">
                  <Spinner className="size-3.5" />
                  <span className="font-mono">{progress.stage}</span>
                  {progress.detail !== undefined ? (
                    <span className="max-w-64 truncate text-muted">{progress.detail}</span>
                  ) : null}
                  {progress.total !== undefined && progress.total > 0 ? (
                    <span className="tnum text-muted">
                      {progress.done ?? 0}/{progress.total}
                    </span>
                  ) : null}
                </span>
              ) : null}
            </div>

            {failure !== null ? (
              <ErrorNote code={failure.code} message={failure.message} remedy={failure.remedy} />
            ) : null}
          </div>
        </Panel>

        {/* ── preview / result ──────────────────────────────────────────── */}
        {summary !== null ? (
          <Panel
            title={
              <span className="flex items-center gap-1.5 text-accent">
                <CheckCircle2 className="size-3.5" />
                Ingested
              </span>
            }
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="documents" value={summary.documentsWritten} tone="accent" />
              <Stat label="replaced" value={summary.documentsReplaced} />
              <Stat label="chunks" value={summary.chunksWritten} />
              <Stat label="elapsed" value={`${(summary.durationMs / 1000).toFixed(1)}s`} />
            </div>
            <p className="mt-3 font-mono text-[11px] text-muted">{summary.sourceRef}</p>
            <StatsGrid stats={summary.stats} />
            {summary.warnings.length > 0 ? <Warnings warnings={summary.warnings} /> : null}
          </Panel>
        ) : preview !== null ? (
          <Panel
            title={
              <span className="flex items-center gap-1.5">
                <FileSearch className="size-3.5" />
                Preview — nothing written yet
              </span>
            }
            actions={
              <Button
                variant="primary"
                size="sm"
                onClick={() => void ingestRepo()}
                loading={busy === 'ingest'}
                disabled={noneSelected}
                title={noneSelected ? 'Select at least one document to ingest.' : undefined}
              >
                <Download className="size-3.5" />
                Ingest {allSelected ? 'all' : selectedCount}
              </Button>
            }
            className="min-h-0 flex-1"
          >
            <StatsGrid stats={preview.stats} />
            {preview.warnings.length > 0 ? <Warnings warnings={preview.warnings} /> : null}

            {/* Select-all header. Tri-state, so a partial selection reads as
                partial instead of as nothing. */}
            <div className="mt-3 flex items-center gap-3 rounded-control border border-line-soft bg-inset/60 px-3 py-2">
              <Checkbox
                checked={allSelected}
                indeterminate={!allSelected && !noneSelected}
                onChange={toggleAllDocuments}
                label={allSelected ? 'Deselect every document' : `Select all ${previewDocuments.length} documents`}
              />
              <span className="min-w-0 flex-1 font-mono text-[11px] uppercase tracking-wider text-muted">
                {selectedCount} of {previewDocuments.length} selected
              </span>
              {noneSelected ? (
                <Badge tone="warn">nothing selected</Badge>
              ) : allSelected ? null : (
                <Badge tone="info">{excluded.size} skipped</Badge>
              )}
            </div>

            <ul className="mt-2 space-y-1">
              {previewDocuments.map((document) => {
                const included = !excluded.has(document.id);
                return (
                  <li
                    key={document.id}
                    className={cn(
                      'flex items-center gap-3 rounded-control border px-3 py-2 transition-colors duration-200',
                      included ? 'border-line-soft bg-inset/40' : 'border-line-soft/60 bg-transparent',
                    )}
                  >
                    <Checkbox
                      checked={included}
                      onChange={() => toggleDocument(document.id)}
                      label={`Ingest ${document.title}`}
                    />
                    {/* Excluded rows dim rather than disappear: a document you
                        cannot see is a document you cannot put back. */}
                    <span className={cn('min-w-0 flex-1', included ? '' : 'opacity-50')}>
                      <span className="block truncate text-xs text-fg">{document.title}</span>
                      <span className="block truncate font-mono text-[10px] text-muted">{document.id}</span>
                    </span>
                    <Badge mono>{(document.charCount / 1000).toFixed(1)}k</Badge>
                  </li>
                );
              })}
            </ul>
          </Panel>
        ) : (
          <Panel className="min-h-0 flex-1">
            <Empty
              icon={<GitBranch className="size-8" />}
              title="No repository analysed yet"
              hint="Analyse first to see exactly which documents would be created and which services were detected. Nothing is written to your corpus until you ingest."
            />
          </Panel>
        )}
      </div>

      {/* ── right: services ──────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-col gap-3">
        <Panel
          title={
            <span className="flex items-center gap-1.5">
              <Database className="size-3.5" />
              Detected services{detected.length > 0 ? ` · ${detected.length}` : ''}
            </span>
          }
          className={detected.length > 0 ? 'max-h-[55%]' : ''}
        >
          {detected.length === 0 ? (
            <p className="text-xs leading-relaxed text-muted">
              After analysing a repository, the services it depends on appear here — inferred from dependencies,
              container definitions, infrastructure-as-code and <span className="font-mono">.env</span> samples. Connect
              one to ingest its live schema.
            </p>
          ) : (
            <ul className="space-y-2">
              {detected.map((service) => {
                const descriptor = connectors.find((entry) => entry.kind === service.kind);
                return (
                  <li key={service.kind} className="rounded-control border border-line-soft bg-inset/40 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium text-fg">{service.label}</span>
                          <Badge
                            tone={
                              service.confidence === 'high' ? 'accent' : service.confidence === 'medium' ? 'warn' : 'neutral'
                            }
                          >
                            {service.confidence}
                          </Badge>
                        </div>
                        <span className="font-mono text-[10px] text-faint">{service.kind}</span>
                      </div>
                      {descriptor !== undefined ? (
                        <Button variant="primary" size="sm" onClick={() => openConnector(descriptor, service)}>
                          <Plug className="size-3" />
                          Connect
                        </Button>
                      ) : (
                        <Badge>no connector</Badge>
                      )}
                    </div>

                    <ul className="mt-2 space-y-0.5">
                      {service.evidence.slice(0, 3).map((line, index) => (
                        <li key={index} className="truncate text-[11px] text-muted">
                          · {line}
                        </li>
                      ))}
                    </ul>

                    {service.envVars.length > 0 ? (
                      <p className="mt-1.5 truncate font-mono text-[10px] text-faint">
                        {service.envVars.slice(0, 4).join('  ')}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel
          title={
            <span className="flex items-center gap-1.5">
              <Boxes className="size-3.5" />
              All connectors
            </span>
          }
          className="min-h-0 flex-1"
        >
          <ul className="space-y-1.5">
            {connectors.map((descriptor) => (
              <li key={descriptor.kind}>
                <button
                  type="button"
                  onClick={() => openConnector(descriptor)}
                  className="w-full rounded-control border border-line-soft bg-inset/40 p-2.5 text-left transition-colors hover:border-line hover:bg-inset/50"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-fg">{descriptor.label}</span>
                    <div className="flex shrink-0 gap-1">
                      {descriptor.readsRowData ? (
                        <Badge tone="warn" title="Samples rows to infer structure">
                          samples data
                        </Badge>
                      ) : (
                        <Badge tone="accent">schema only</Badge>
                      )}
                    </div>
                  </div>
                  <p className="mt-1 text-xs leading-snug text-muted">{descriptor.summary}</p>
                  {descriptor.driver !== undefined ? (
                    <p className="mt-1 font-mono text-[10px] text-faint">needs {descriptor.driver}</p>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      {/* ── connector modal ──────────────────────────────────────────────── */}
      <Modal
        open={connector !== null}
        title={connector === null ? '' : `Connect ${connector.label}`}
        onClose={() => setConnector(null)}
        footer={
          <>
            {connectorProgress !== null ? (
              <span className="mr-auto flex items-center gap-2 text-xs text-muted">
                <Spinner className="size-3.5" />
                <span className="font-mono">{connectorProgress.stage}</span>
                {connectorProgress.detail !== undefined ? (
                  <span className="max-w-48 truncate text-faint">{connectorProgress.detail}</span>
                ) : null}
              </span>
            ) : null}
            <Button variant="ghost" onClick={() => setConnector(null)}>
              Close
            </Button>
            <Button variant="primary" loading={connectorBusy} onClick={() => void runConnector()}>
              <Download className="size-3.5" />
              Introspect &amp; ingest
            </Button>
          </>
        }
      >
        {connector !== null ? (
          <div className="space-y-3.5">
            <div className="rounded-control border border-line-soft bg-inset/50 p-3">
              <p className="text-xs leading-relaxed text-fg">{connector.summary}</p>
              <p className="mt-1.5 text-xs leading-relaxed text-muted">
                <span className="font-medium text-muted">Produces:</span> {connector.produces}
              </p>
              <p
                className={cn(
                  'mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed',
                  connector.readsRowData ? 'text-warn' : 'text-accent',
                )}
              >
                {connector.readsRowData ? (
                  <ShieldAlert className="mt-0.5 size-3 shrink-0" />
                ) : (
                  <CheckCircle2 className="mt-0.5 size-3 shrink-0" />
                )}
                {connector.readsRowData
                  ? 'This connector samples records to infer structure. Field names, types and presence rates are stored; values are not, except small enum-like sets.'
                  : 'This connector reads schema metadata only. No records are read.'}
              </p>
            </div>

            {connector.driver !== undefined ? (
              <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted">
                <Info className="mt-0.5 size-3 shrink-0" />
                Requires the <code className="font-mono text-fg">{connector.driver}</code> driver in your project.
                Drivers are optional peers, so you install only the ones you use.
              </p>
            ) : null}

            <div className="space-y-3">
              {connector.fields.map((field) => {
                const hint = [field.help, field.envHint !== undefined ? `Often ${field.envHint}.` : undefined]
                  .filter((part): part is string => part !== undefined)
                  .join(' ');
                const detectedHint = form[`__hint_${field.name}`];

                if (field.type === 'boolean') {
                  return (
                    <label key={field.name} className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={form[field.name] === true}
                        onChange={(event) => setForm({ ...form, [field.name]: event.target.checked })}
                        className="accent-[var(--color-accent)]"
                      />
                      <span className="text-xs text-fg">{field.label}</span>
                    </label>
                  );
                }

                return (
                  <Field
                    key={field.name}
                    label={field.label}
                    required={field.required}
                    hint={
                      typeof detectedHint === 'string' && detectedHint.length > 0
                        ? `${hint} Detected in the repo: ${detectedHint}`
                        : hint.length > 0
                          ? hint
                          : undefined
                    }
                  >
                    {(bound) => (
                      <Input
                        {...bound}
                        type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
                        value={String(form[field.name] ?? '')}
                        onChange={(event) => setForm({ ...form, [field.name]: event.target.value })}
                        {...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {})}
                        className={field.type === 'password' ? 'font-mono' : ''}
                      />
                    )}
                  </Field>
                );
              })}
            </div>

            {connectorFailure !== null ? (
              <ErrorNote
                code={connectorFailure.code}
                message={connectorFailure.message}
                remedy={connectorFailure.remedy}
              />
            ) : null}

            {connectorResult !== null ? (
              <div className="rounded-control border border-accent/35 bg-accent/8 p-3">
                <div className="flex items-center gap-1.5">
                  <CheckCircle2 className="size-3.5 text-accent" />
                  <span className="text-sm font-medium text-accent">Ingested</span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-3">
                  <Stat label="documents" value={connectorResult.documentsWritten} tone="accent" />
                  <Stat label="chunks" value={connectorResult.chunksWritten} />
                  <Stat label="elapsed" value={`${(connectorResult.durationMs / 1000).toFixed(1)}s`} />
                </div>
                <StatsGrid stats={connectorResult.stats} />
                {connectorResult.warnings.length > 0 ? <Warnings warnings={connectorResult.warnings} /> : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function StatsGrid({ stats }: { stats: Readonly<Record<string, number | string>> }): ReactNode {
  const entries = Object.entries(stats);
  if (entries.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-line-soft pt-2.5">
      {entries.map(([key, value]) => (
        <span key={key} className="font-mono text-[10px] text-muted">
          <span className="text-faint">{key}=</span>
          {String(value)}
        </span>
      ))}
    </div>
  );
}

function Warnings({ warnings }: { warnings: readonly string[] }): ReactNode {
  return (
    <ul className="mt-3 space-y-1">
      {warnings.map((warning, index) => (
        <li key={index} className="flex items-start gap-1.5 text-xs leading-relaxed text-warn">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          {warning}
        </li>
      ))}
    </ul>
  );
}
