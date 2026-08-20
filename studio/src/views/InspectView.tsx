import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  Bot,
  Cloud,
  Code,
  Copy,
  FileText,
  HardDrive,
  Radio,
  RefreshCw,
  ScanSearch,
  Search,
  Trash2,
  Workflow,
} from 'lucide-react';

import type { ModelCallRecord, ModelCallStage, ModelCallStats } from '@localmind/protocol';

import { api, ApiError } from '../lib/api';
import { cn } from '../lib/cn';
import { Badge, Button, Empty, ErrorNote, Input, Panel, SkeletonRows, Stat } from '../components/ui';
import { Streamdown } from 'streamdown';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '../components/select';

/**
 * The Inspect view: every prompt this process sent to a model, and what came
 * back.
 *
 * WHY THIS TAB EXISTS
 *
 * The other four tabs show what the pipeline *decided*. This one shows what it
 * actually said. When a grounded answer is wrong the cause is almost never the
 * model — it is the prompt: the wrong chunks were retrieved, the right ones were
 * truncated out by the token budget, or the instructions did not survive a
 * rewrite. None of that is visible from the answer, and all of it is visible
 * here.
 *
 * TWO-PANE, NOT ACCORDION
 *
 * A prompt is 1500-4000 tokens. Expanding one inline pushes every other row off
 * screen, so choosing what to compare becomes scrolling rather than clicking. A
 * list beside a detail pane keeps the set visible while you read one of them —
 * which is the whole activity this view is for.
 *
 * The detail pane refetches the selected call, because the list response
 * truncates text: 100 rows at 12 KB each would make the page slower than the
 * pipeline it is meant to explain.
 */

const STAGE_META: Record<
  ModelCallStage,
  { label: string; tone: 'neutral' | 'accent' | 'info' | 'warn' | 'danger'; icon: ReactNode; hint: string }
> = {
  ground: {
    label: 'ground',
    tone: 'accent',
    icon: <BadgeCheck className="size-2.5" aria-hidden />,
    hint: 'Answer generation from retrieved context.',
  },
  agent: {
    label: 'agent',
    tone: 'accent',
    icon: <Bot className="size-2.5" aria-hidden />,
    hint: 'The tool-calling retrieval agent choosing what to search for.',
  },
  plan: {
    label: 'plan',
    tone: 'info',
    icon: <Workflow className="size-2.5" aria-hidden />,
    hint: 'Decomposing the question into sub-queries.',
  },
  grade: {
    label: 'grade',
    tone: 'info',
    icon: <ScanSearch className="size-2.5" aria-hidden />,
    hint: 'Scoring retrieved chunks for relevance.',
  },
  rewrite: {
    label: 'rewrite',
    tone: 'warn',
    icon: <RefreshCw className="size-2.5" aria-hidden />,
    hint: 'Reformulating a query that retrieved nothing useful.',
  },
  verify: {
    label: 'verify',
    tone: 'warn',
    icon: <AlertTriangle className="size-2.5" aria-hidden />,
    hint: 'Auditing whether the answer is supported by its sources.',
  },
  analyze: {
    label: 'analyze',
    tone: 'info',
    icon: <ScanSearch className="size-2.5" aria-hidden />,
    hint: 'Writing architecture documentation for an ingested repository.',
  },
  unknown: {
    label: 'unknown',
    tone: 'neutral',
    icon: null,
    hint: 'No stage matched this prompt — a direct call through the exported primitives.',
  },
};

const STAGE_ORDER: readonly ModelCallStage[] = [
  'ground',
  'agent',
  'plan',
  'grade',
  'rewrite',
  'verify',
  'analyze',
  'unknown',
];

const ANY = '__any__';

function stageMeta(stage: ModelCallStage): (typeof STAGE_META)[ModelCallStage] {
  return STAGE_META[stage] ?? STAGE_META.unknown;
}

function clock(iso: string): string {
  // Local wall-clock only. A full date on every row in a session log is noise;
  // the ISO value stays in the `title` for anyone correlating with server logs.
  return iso.slice(11, 19);
}

export function InspectView(): ReactNode {
  const [data, setData] = useState<{ calls: readonly ModelCallRecord[]; stats: ModelCallStats; enabled: boolean } | null>(
    null,
  );
  const [error, setError] = useState<{ code: string; message: string; remedy: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const [stage, setStage] = useState<string>(ANY);
  const [status, setStatus] = useState<string>(ANY);
  const [search, setSearch] = useState('');
  const [live, setLive] = useState(true);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ModelCallRecord | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(
        await api.calls.list({
          ...(stage !== ANY ? { stage } : {}),
          ...(status !== ANY ? { status } : {}),
          ...(search.length > 0 ? { search } : {}),
          limit: 200,
        }),
      );
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? { code: caught.code, message: caught.message, remedy: caught.remedy }
          : { code: 'NETWORK', message: String(caught), remedy: 'Is the API process running?' },
      );
    } finally {
      setLoading(false);
    }
  }, [stage, status, search]);

  // Debounced, so typing in the filter does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => void load(), 200);
    return () => clearTimeout(timer);
  }, [load]);

  /*
   * Polling, not SSE.
   *
   * A model call is recorded when it *completes*, so there is no partial state
   * to stream and nothing to render mid-flight. A 2s poll of a bounded in-memory
   * buffer costs one cheap request; a second SSE endpoint would cost a
   * long-lived connection and its own reconnect handling for no extra fidelity.
   *
   * It stops while a call is selected: refetching the list under the user would
   * reorder the rows they are reading from.
   */
  useEffect(() => {
    if (!live || selectedId !== null) return undefined;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [live, selectedId, load]);

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    void api.calls
      .get(selectedId)
      .then((record) => {
        if (!cancelled) {
          setDetail(record);
          setDetailError(null);
        }
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setDetail(null);
        setDetailError(
          caught instanceof ApiError
            ? caught.message
            : 'Could not load that call — it may have been evicted from the buffer.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const calls = data?.calls ?? [];
  const stats = data?.stats;

  const filtered = stage !== ANY || status !== ANY || search.length > 0;

  const stageCounts = useMemo(() => stats?.byStage ?? {}, [stats]);

  const clear = useCallback(async () => {
    await api.calls.clear();
    setSelectedId(null);
    await load();
  }, [load]);

  const remove = useCallback(
    async (id: string) => {
      await api.calls.remove(id);
      // Clear the selection only if it was the deleted row, so removing noise
      // from the list does not close the call you were reading.
      setSelectedId((previous) => (previous === id ? null : previous));
      await load();
    },
    [load],
  );

  return (
    <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      {/* ── left: the log ─────────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-col gap-3">
        {/* ── stats ───────────────────────────────────────────────────────── */}
        <div className="lm-lift grid shrink-0 grid-cols-2 gap-3 rounded-panel border border-line-soft bg-surface p-3 sm:grid-cols-4">
          <Stat label="calls" value={stats?.total ?? '—'} loading={stats === undefined && loading} />
          <Stat
            label="failed"
            value={stats?.failed ?? '—'}
            loading={stats === undefined && loading}
            {...((stats?.failed ?? 0) > 0 ? { tone: 'danger' as const } : {})}
          />
          <Stat
            label="tokens in/out"
            value={stats === undefined ? '—' : `${stats.inputTokens}/${stats.outputTokens}`}
            loading={stats === undefined && loading}
            title="Reported by the provider. Blank when the provider sends no usage."
          />
          <Stat
            label="slowest"
            value={stats === undefined ? '—' : `${(stats.slowestMs / 1000).toFixed(1)}s`}
            loading={stats === undefined && loading}
          />
        </div>

        {/* ── filters ─────────────────────────────────────────────────────── */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <div className="relative min-w-48 flex-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint"
              aria-hidden
            />
            <label className="sr-only" htmlFor="lm-calls-filter">
              Search prompts and responses
            </label>
            <Input
              id="lm-calls-filter"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search prompt or response…"
              className="pl-8"
            />
          </div>

          <Select value={stage} onValueChange={setStage}>
            <SelectTrigger aria-label="Filter by pipeline stage" className="w-40 font-mono text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ANY} className="font-mono text-xs">
                  all stages
                </SelectItem>
              </SelectGroup>
              <SelectGroup>
                <SelectLabel>stage</SelectLabel>
                {STAGE_ORDER.map((entry) => (
                  <SelectItem key={entry} value={entry} className="font-mono text-xs">
                    <span>{stageMeta(entry).label}</span>
                    <span className="ml-auto shrink-0 pl-3 text-[10px] tnum text-faint">
                      {stageCounts[entry] ?? 0}
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>

          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger aria-label="Filter by outcome" className="w-32 font-mono text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY} className="font-mono text-xs">
                any outcome
              </SelectItem>
              <SelectItem value="ok" className="font-mono text-xs">
                succeeded
              </SelectItem>
              <SelectItem value="failed" className="font-mono text-xs">
                failed
              </SelectItem>
            </SelectContent>
          </Select>

          {/* Live polling is a toggle rather than always-on: it reorders rows,
              which is unwelcome while you are reading one. */}
          <Button
            variant={live ? 'primary' : 'outline'}
            size="sm"
            onClick={() => setLive((previous) => !previous)}
            aria-pressed={live}
            title={
              live
                ? 'Polling every 2s. Pauses automatically while a call is open.'
                : 'Paused. The list refreshes only when you change a filter.'
            }
          >
            <Radio className={cn('size-3.5', live && selectedId === null ? 'animate-pulse' : '')} aria-hidden />
            {live ? 'Live' : 'Paused'}
          </Button>

          <Button variant="outline" size="sm" onClick={() => void load()} aria-label="Refresh now">
            <RefreshCw className="size-3.5" aria-hidden />
          </Button>

          <Button
            variant="danger"
            size="sm"
            onClick={() => void clear()}
            disabled={(stats?.total ?? 0) === 0}
            title="Empty the whole buffer. Nothing is written to disk, so this is not undoable."
          >
            <Trash2 className="size-3.5" aria-hidden />
            Clear all
          </Button>
        </div>

        {error !== null ? <ErrorNote code={error.code} message={error.message} remedy={error.remedy} /> : null}

        {/* ── list ────────────────────────────────────────────────────────── */}
        <Panel
          title={
            <span className="flex items-center gap-1.5">
              Model calls
              {stats !== undefined ? (
                <span className="font-normal normal-case text-faint">
                  {calls.length} shown · buffer {stats.total}/{stats.capacity}
                  {stats.evicted > 0 ? ` · ${stats.evicted} evicted` : ''}
                </span>
              ) : null}
            </span>
          }
          className="min-h-0 flex-1"
          bodyClassName="p-0"
          busy={loading}
        >
          {loading && data === null ? (
            <div className="p-3.5">
              <SkeletonRows rows={8} />
            </div>
          ) : data?.enabled === false ? (
            <Empty
              icon={<Radio className="size-8" />}
              title="Recording is switched off"
              hint="This LocalMind instance was opened with `recorder: { enabled: false }`, so no prompts are captured. Restart without that option to use this view."
            />
          ) : calls.length === 0 ? (
            <Empty
              icon={<ScanSearch className="size-8" />}
              title={filtered ? 'No calls match these filters' : 'No model calls yet'}
              hint={
                filtered
                  ? 'Clear the filters to see everything still in the buffer.'
                  : 'Ask a question in Chat, or ingest a repository in Sources. Every prompt this process sends appears here with its response.'
              }
            />
          ) : (
            <ul className="divide-y divide-line-soft">
              {calls.map((call) => {
                const meta = stageMeta(call.stage);
                const selected = selectedId === call.id;
                return (
                  <li
                    key={call.id}
                    className={cn(
                      'group relative transition-colors duration-200',
                      selected ? 'bg-accent/10' : 'hover:bg-inset/50',
                    )}
                  >
                    {/* A <button> may not contain another <button>, so the row
                        selector and the delete control are siblings, with the
                        delete absolutely positioned over the row's top-right. */}
                    <button
                      type="button"
                      onClick={() => setSelectedId(selected ? null : call.id)}
                      aria-current={selected ? 'true' : undefined}
                      className="w-full cursor-pointer px-3.5 py-2.5 pr-10 text-left"
                    >
                      <div className="flex items-center gap-2">
                        <Badge tone={call.ok ? meta.tone : 'danger'} title={meta.hint}>
                          {call.ok ? meta.icon : <AlertTriangle className="size-2.5" aria-hidden />}
                          {meta.label}
                        </Badge>
                        <span className="truncate font-mono text-[10px] text-muted" title={call.startedAt}>
                          {clock(call.startedAt)}
                        </span>
                        <span className="flex-1" />
                        <span className="shrink-0 font-mono text-[10px] tnum text-muted">
                          {(call.durationMs / 1000).toFixed(1)}s
                        </span>
                      </div>

                      {/* The first line of the user message: the closest thing a
                          model call has to a subject line. */}
                      <p className="mt-1 truncate text-xs text-fg">
                        {call.messages.find((message) => message.role === 'user')?.text.split('\n')[0] ??
                          call.system?.split('\n')[0] ??
                          '(no prompt text)'}
                      </p>

                      <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10px] tnum text-faint">
                        <span title="Which registry model served this call">{call.role}</span>
                        <span>{call.operation}</span>
                        <span title="Prompt tokens, estimated locally">~{call.estimatedPromptTokens} tok</span>
                        {call.usage?.outputTokens !== undefined ? <span>out {call.usage.outputTokens}</span> : null}
                        {call.tools.length > 0 ? <span>{call.tools.length} tools</span> : null}
                        {call.settings.responseFormat === 'json' ? <span>json</span> : null}
                      </div>
                    </button>

                    {/*
                      Stays in the DOM and only changes opacity, so it is
                      keyboard-reachable — a hover-only affordance is unreachable
                      without a pointer. No confirmation: this discards one line
                      of a session-scoped debug log, which is not a destructive
                      act worth a dialog.
                    */}
                    <div className="absolute right-2 top-2 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void remove(call.id)}
                        aria-label={`Delete this ${call.stage} call from the log`}
                        title="Delete this entry"
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>

      {/* ── right: the selected call ──────────────────────────────────────── */}
      <CallDetail record={detail} error={detailError} pending={selectedId !== null && detail === null} />
    </div>
  );
}

/* ── detail pane ─────────────────────────────────────────────────────────── */

function CallDetail({
  record,
  error,
  pending,
}: {
  record: ModelCallRecord | null;
  error: string | null;
  pending: boolean;
}): ReactNode {
  if (error !== null) {
    return (
      <Panel title="Call" className="min-h-0">
        <ErrorNote code="NOT_FOUND" message={error} remedy="The buffer keeps recent calls only; older ones are evicted." />
      </Panel>
    );
  }

  if (pending) {
    return (
      <Panel title="Call" className="min-h-0">
        <SkeletonRows rows={6} />
      </Panel>
    );
  }

  if (record === null) {
    return (
      <Panel className="min-h-0">
        <Empty
          icon={<ScanSearch className="size-8" />}
          title="Select a call"
          hint="The full prompt as the provider received it, and the response as it came back. Nothing is truncated here."
        />
      </Panel>
    );
  }

  const meta = stageMeta(record.stage);
  // Local providers are the ones the product exists for; the icon says which
  // side of the network the call went to at a glance.
  const isLocal = record.provider.includes('ollama');

  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone={record.ok ? meta.tone : 'danger'} title={meta.hint}>
            {meta.icon}
            {meta.label}
          </Badge>
          <span className="font-normal normal-case text-muted" title={record.startedAt}>
            {clock(record.startedAt)}
          </span>
        </span>
      }
      actions={
        <CopyButton
          label="Copy prompt"
          text={[record.system ?? '', ...record.messages.map((message) => `[${message.role}]\n${message.text}`)]
            .filter((part) => part.length > 0)
            .join('\n\n')}
        />
      }
      className="min-h-0"
    >
      <div className="space-y-3.5">
        {/* ── facts ───────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="model" value={record.modelId} title={`${record.provider}/${record.modelId}`} />
          <Stat label="duration" value={`${(record.durationMs / 1000).toFixed(2)}s`} />
          <Stat
            label="tokens in/out"
            value={
              record.usage === undefined
                ? `~${record.estimatedPromptTokens}/—`
                : `${record.usage.inputTokens ?? '—'}/${record.usage.outputTokens ?? '—'}`
            }
            title={
              record.usage === undefined
                ? 'This provider reported no usage, so the input figure is our own estimate.'
                : 'Reported by the provider.'
            }
          />
          <Stat
            label="finish"
            value={record.finishReason ?? '—'}
            {...(record.ok ? {} : { tone: 'danger' as const })}
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={isLocal ? 'accent' : 'info'} title={`provider: ${record.provider}`}>
            {isLocal ? <HardDrive className="size-2.5" aria-hidden /> : <Cloud className="size-2.5" aria-hidden />}
            {isLocal ? 'local' : 'api'}
          </Badge>
          <Badge>{record.operation}</Badge>
          <Badge>{record.role}</Badge>
          {record.settings.temperature !== undefined ? (
            <Badge>temp {record.settings.temperature}</Badge>
          ) : null}
          {record.settings.maxOutputTokens !== undefined ? (
            <Badge>max {record.settings.maxOutputTokens}</Badge>
          ) : null}
          {record.settings.responseFormat === 'json' ? <Badge tone="info">structured output</Badge> : null}
          {record.tools.map((tool) => (
            <Badge key={tool} tone="info">
              {tool}
            </Badge>
          ))}
        </div>

        {record.error !== undefined ? (
          <ErrorNote code="CALL_FAILED" message={record.error} remedy="" />
        ) : null}

        {record.warnings.length > 0 ? (
          <div className="rounded-control border border-warn/35 bg-warn/8 p-2.5">
            <p className="font-mono text-[10px] uppercase tracking-wider text-warn">
              {record.warnings.length} warning(s)
            </p>
            {record.warnings.map((warning, index) => (
              <pre key={index} className="lm-wrap-any mt-1 whitespace-pre-wrap text-xs text-muted">
                {warning}
              </pre>
            ))}
          </div>
        ) : null}

        {/* ── the prompt ──────────────────────────────────────────────────── */}
        {record.system !== undefined ? (
          <Block title="system" subtitle="the stage's instructions" text={record.system} />
        ) : null}

        {record.messages.map((message, index) => (
          <Block key={index} title={message.role} text={message.text} />
        ))}

        {/* ── the response ────────────────────────────────────────────────── */}
        <Block
          title="response"
          subtitle={record.toolCalls.length > 0 ? `${record.toolCalls.length} tool call(s)` : undefined}
          text={record.responseText.length > 0 ? record.responseText : '(no text — the model only called tools)'}
          tone="accent"
        />

        {record.toolCalls.length > 0 ? (
          <Block title="tool calls" text={record.toolCalls.join('\n\n')} tone="info" />
        ) : null}
      </div>
    </Panel>
  );
}

/**
 * One labelled block of prompt or response text.
 *
 * `whitespace-pre-wrap` and a max height, because these are 1500-4000 token
 * strings whose *formatting is the point* — a context block's `<source id="S1">`
 * scaffolding and its line breaks are exactly what you came to check. Collapsing
 * whitespace would hide the bug.
 */
function Block({
  title,
  subtitle,
  text,
  tone,
}: {
  title: string;
  subtitle?: string;
  text: string;
  tone?: 'accent' | 'info';
}): ReactNode {
  const border = tone === 'accent' ? 'border-accent/30' : tone === 'info' ? 'border-info/30' : 'border-line-soft';
  const [showRawMarkdown, setShowRawMarkdown] = useState(false);

  return (
    <div className={cn('rounded-control border bg-inset/40', border)}>
      <div className="flex items-center gap-2 border-b border-line-soft px-2.5 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">{title}</span>
        {subtitle !== undefined ? <span className="text-[10px] text-faint">{subtitle}</span> : null}
        <span className="flex-1" />
        <span className="font-mono text-[10px] tnum text-faint">{text.length.toLocaleString()} chars</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowRawMarkdown((v) => !v)}
          aria-label={showRawMarkdown ? 'Switch to rendered markdown' : 'Switch to raw markdown'}
          className="text-muted hover:text-fg"
        >
          {showRawMarkdown ? <FileText className="size-3.5" aria-hidden /> : <Code className="size-3.5" aria-hidden />}
        </Button>
      </div>
      <div className="px-2.5 py-2">
        {showRawMarkdown ? (
          <Streamdown className="lm-markdown" mode="static" parseIncompleteMarkdown controls={{ code: true, table: true, mermaid: true }}>
            {text}
          </Streamdown>
        ) : (
          <pre className="lm-wrap-any max-h-96 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-fg">
            {text}
          </pre>
        )}
      </div>
    </div>
  );
}

function CopyButton({ label, text, compact = false }: { label: string; text: string; compact?: boolean }): ReactNode {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        // Reverts on its own: a permanently-ticked button stops meaning anything.
        setTimeout(() => setCopied(false), 1400);
      },
      () => setCopied(false),
    );
  }, [text]);

  return (
    <Button variant="ghost" size={compact ? 'icon' : 'sm'} onClick={copy} aria-label={label} title={label}>
      {copied ? (
        <BadgeCheck className="size-3.5 text-accent" aria-hidden />
      ) : (
        <Copy className="size-3.5" aria-hidden />
      )}
      {compact ? null : copied ? 'Copied' : 'Copy prompt'}
    </Button>
  );
}
