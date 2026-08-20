import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { Search, SlidersHorizontal } from 'lucide-react';

import type { RetrievedChunk } from '@localmind/protocol';

import { api, ApiError } from '../lib/api';
import { Badge, Button, Empty, ErrorNote, Input, Panel, Spinner } from '../components/ui';

/**
 * Raw retrieval, no generation.
 *
 * This is the debugging view, and it earns its place in the navigation: when an
 * answer is wrong, the first question is always whether the right passage was
 * even retrieved. Answering that here — with scores, distances and chunk ids
 * visible — separates a retrieval problem from a prompting problem in seconds.
 *
 * The score/minScore relationship is surfaced explicitly because it is the most
 * common misconfiguration: a threshold set too high silently produces
 * abstentions that look like a broken model.
 */
export function SearchView(): ReactNode {
  const [query, setQuery] = useState('');
  const [topK, setTopK] = useState(8);
  const [minScore, setMinScore] = useState(0);
  const [results, setResults] = useState<readonly RetrievedChunk[] | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ code: string; message: string; remedy: string } | null>(null);

  const run = useCallback(async () => {
    if (query.trim().length === 0) return;
    setBusy(true);
    setFailure(null);
    try {
      const response = await api.search({ query: query.trim(), topK, minScore });
      setResults(response.results);
      setElapsed(response.durationMs);
    } catch (error) {
      setFailure(
        error instanceof ApiError
          ? { code: error.code, message: error.message, remedy: error.remedy }
          : { code: 'NETWORK', message: String(error), remedy: 'Is the API process running?' },
      );
    } finally {
      setBusy(false);
    }
  }, [query, topK, minScore]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Panel
        title={
          <span className="flex items-center gap-1.5">
            <SlidersHorizontal className="size-3.5" />
            Retrieval only
          </span>
        }
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void run();
              }}
              placeholder="cosine distance · refund window · how retries are configured"
            />
          </div>
          <label className="space-y-1">
            <span className="block text-[10px] uppercase tracking-wider text-muted">topK</span>
            <Input
              type="number"
              min={1}
              max={30}
              value={topK}
              onChange={(event) => setTopK(Number(event.target.value))}
              className="w-20"
            />
          </label>
          <label className="space-y-1">
            <span className="block text-[10px] uppercase tracking-wider text-muted">minScore</span>
            <Input
              type="number"
              step="0.05"
              min={0}
              max={1}
              value={minScore}
              onChange={(event) => setMinScore(Number(event.target.value))}
              className="w-24"
            />
          </label>
          <Button variant="primary" onClick={() => void run()} loading={busy} disabled={query.trim().length === 0}>
            <Search className="size-4" />
            Search
          </Button>
        </div>
        <p className="mt-2.5 text-xs leading-relaxed text-muted">
          Set <code className="font-mono">minScore</code> to 0 to see the nearest neighbours regardless of score. If even
          those are unrelated, the corpus does not cover the topic — a corpus problem, not a prompt problem.
        </p>
        {failure !== null ? (
          <div className="mt-3">
            <ErrorNote code={failure.code} message={failure.message} remedy={failure.remedy} />
          </div>
        ) : null}
      </Panel>

      <Panel
        title={results === null ? 'Results' : `${results.length} result(s) in ${elapsed}ms`}
        className="min-h-0 flex-1"
        bodyClassName="p-0"
      >
        {busy && results === null ? (
          <div className="flex h-32 items-center justify-center">
            <Spinner />
          </div>
        ) : results === null ? (
          <Empty
            icon={<Search className="size-8" />}
            title="Run a query"
            hint="Results show the cosine score, the raw LanceDB distance, and the chunk id — everything needed to tell whether retrieval or prompting is at fault."
          />
        ) : results.length === 0 ? (
          <Empty
            icon={<Search className="size-8" />}
            title="Nothing above the threshold"
            hint="Lower minScore to inspect the nearest neighbours anyway."
          />
        ) : (
          <ol className="divide-y divide-line-soft">
            {results.map((chunk, index) => (
              <li key={chunk.id} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="accent" mono>
                    #{index + 1}
                  </Badge>
                  <span className="font-mono text-sm font-semibold text-fg">{chunk.score.toFixed(3)}</span>
                  <span className="font-mono text-[10px] text-faint">dist {chunk.distance.toFixed(3)}</span>
                  <span className="truncate text-xs font-medium text-fg">{chunk.title}</span>
                  {chunk.headingPath.length > 0 ? (
                    <span className="truncate text-[11px] text-muted">› {chunk.headingPath}</span>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-faint">
                  <span className="truncate">{chunk.relativePath}</span>
                  <span>chunk {chunk.chunkIndex}</span>
                  <span>~{chunk.tokenEstimate} tok</span>
                  <span>{chunk.id.slice(0, 12)}</span>
                </div>
                <p className="max-h-44 overflow-y-auto whitespace-pre-wrap rounded-control border border-line-soft bg-inset/50 p-2.5 text-[12px] leading-relaxed text-muted">
                  {chunk.text}
                </p>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
}
