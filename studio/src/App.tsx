import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Brain, Database, GitBranch, MessageSquare, RefreshCw, ScanSearch, Search, Settings2 } from 'lucide-react';

import type { HealthResponse } from '@localmind/protocol';

import { api, ApiError } from './lib/api';
import { cn } from './lib/cn';
import { Badge, Button, ErrorNote, SkeletonRows } from './components/ui';
import { ChatView } from './views/ChatView';
import { CorpusView } from './views/CorpusView';
import { SearchView } from './views/SearchView';
import { SettingsView } from './views/SettingsView';
import { InspectView } from './views/InspectView';
import { SourcesView } from './views/SourcesView';

/**
 * The shell.
 *
 * Tabs rather than a router: six views with no shareable deep state, and adding
 * a router would mean shipping one inside a library bundle for no user-visible
 * benefit. The tab list is a real `role="tablist"`, and the active tab is marked
 * by weight, background *and* `aria-selected` — never colour alone.
 *
 * `health` is the single shared piece of state, and it is refetched after any
 * corpus mutation rather than optimistically patched. Document and chunk counts
 * come from two LanceDB tables plus the manifest; guessing what they became
 * after an edit is exactly the duplicated bookkeeping that ends up disagreeing
 * with reality.
 */

type Tab = 'chat' | 'corpus' | 'sources' | 'search' | 'inspect' | 'settings';

const TABS: readonly { id: Tab; label: string; icon: ReactNode; stage?: string }[] = [
  {
    id: 'chat',
    label: 'Chat',
    icon: <MessageSquare className="size-4" aria-hidden />,
    stage: 'ground · delegate · verify',
  },
  { id: 'corpus', label: 'Corpus', icon: <Database className="size-4" aria-hidden />, stage: 'index' },
  { id: 'sources', label: 'Sources', icon: <GitBranch className="size-4" aria-hidden /> },
  { id: 'search', label: 'Search', icon: <Search className="size-4" aria-hidden />, stage: 'index' },
  {
    id: 'inspect',
    label: 'Inspect',
    icon: <ScanSearch className="size-4" aria-hidden />,
    stage: 'prompts',
  },
  { id: 'settings', label: 'Settings', icon: <Settings2 className="size-4" aria-hidden /> },
];

export function App(): ReactNode {
  const [tab, setTab] = useState<Tab>('chat');
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [failure, setFailure] = useState<{ code: string; message: string; remedy: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setHealth(await api.health());
      setFailure(null);
    } catch (error) {
      setFailure(
        error instanceof ApiError
          ? { code: error.code, message: error.message, remedy: error.remedy }
          : {
            code: 'NETWORK',
            message: String(error),
            remedy: 'Start the API with `bun run studio` (or `bun run studio:api` when running Vite separately).',
          },
      );
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const corpusEmpty = (health?.corpus.documents ?? 0) === 0;

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* ── header ──────────────────────────────────────────────────────── */}
      <header className="flex shrink-0 items-center gap-4 border-b border-line-soft px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <span
            className="lm-lift flex size-7 items-center justify-center rounded-control border border-accent/25 bg-accent/12 text-accent"
            aria-hidden
          >
            <Brain className="size-4" />
          </span>
          <div className="leading-tight">
            {/* Mono wordmark: this is a developer tool, and the type pairing puts
                machine-adjacent text in Fira Code. */}
            <h1 className="font-mono text-sm font-semibold tracking-tight text-fg">LocalMind</h1>
            <p className="font-mono text-[10px] text-muted">local-first agentic RAG</p>
          </div>
        </div>

        <nav role="tablist" aria-label="Views" className="flex flex-1 items-center gap-1">
          {TABS.map((entry) => {
            const selected = tab === entry.id;
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setTab(entry.id)}
                className={cn(
                  'relative inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-control px-3 py-1.5',
                  'text-sm transition-colors duration-200 ease-out-soft',
                  // Selected state is carried by fill, weight AND the rule
                  // below — never by colour alone.
                  selected
                    ? 'bg-inset font-semibold text-fg after:absolute after:inset-x-2 after:-bottom-1.75 after:h-0.5 after:bg-accent after:content-[""]'
                    : 'font-medium text-muted hover:bg-inset/60 hover:text-fg',
                )}
              >
                {entry.icon}
                {entry.label}
                {entry.stage !== undefined ? (
                  <span className="hidden font-mono text-[10px] text-faint 2xl:inline">{entry.stage}</span>
                ) : null}
              </button>
            );
          })}
        </nav>

        {health !== null ? (
          <div className="hidden items-center gap-1.5 rounded-control border border-line-soft bg-surface/60 px-1.5 py-1 md:flex">
            <Badge tone={corpusEmpty ? 'warn' : 'accent'}>{health.corpus.documents} docs</Badge>
            <Badge>{health.corpus.chunks} chunks</Badge>
            <Badge tone="info" title={health.models.chat}>
              {health.models.chat.split('/').slice(-1)[0]}
            </Badge>
          </div>
        ) : null}

        <Button variant="ghost" size="icon" onClick={() => void refresh()} aria-label="Refresh status">
          <RefreshCw className={cn('size-4', refreshing ? 'animate-spin' : '')} aria-hidden />
        </Button>
      </header>

      {/* ── body ────────────────────────────────────────────────────────── */}
      <main className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        {failure !== null ? (
          <ErrorNote code={failure.code} message={failure.message} remedy={failure.remedy} />
        ) : null}

        {/* Skeletons shaped like the layout that is about to arrive, so the first
            paint does not reflow when data lands. */}
        {health === null && failure === null ? (
          <div className="grid flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="lm-lift rounded-panel border border-line-soft bg-surface p-4">
              <SkeletonRows rows={6} />
            </div>
            <div className="lm-lift hidden rounded-panel border border-line-soft bg-surface p-4 lg:block">
              <SkeletonRows rows={4} />
            </div>
          </div>
        ) : null}

        {health !== null ? (
          <>
            {tab === 'chat' ? <ChatView corpusEmpty={corpusEmpty} /> : null}
            {tab === 'corpus' ? <CorpusView onCorpusChanged={() => void refresh()} /> : null}
            {tab === 'sources' ? (
              <SourcesView connectors={health.connectors} onCorpusChanged={() => void refresh()} />
            ) : null}
            {tab === 'search' ? <SearchView /> : null}
            {tab === 'inspect' ? <InspectView /> : null}
            {tab === 'settings' ? <SettingsView health={health} /> : null}
          </>
        ) : null}
      </main>
    </div>
  );
}
