import type { ReactNode } from 'react';
import { Cpu, Database, HardDrive, Settings2, Sliders } from 'lucide-react';

import type { HealthResponse } from '@localmind/protocol';

import { Badge, Panel, Stat } from '../components/ui';

/**
 * Read-only configuration view.
 *
 * Deliberately read-only. Configuration is environment-driven — `loadConfig` is
 * the only reader of `process.env` in the whole library — and letting a UI mutate
 * it would create a second source of truth that disagrees with the `.env` a
 * deployment actually boots from. Showing the resolved values, and naming the
 * variable that controls each one, is more useful than an editor whose changes
 * quietly vanish on restart.
 */
export function SettingsView({ health }: { health: HealthResponse }): ReactNode {
  return (
    <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto lg:grid-cols-2">
      <div className="space-y-3">
        <Panel
          title={
            <span className="flex items-center gap-1.5">
              <Cpu className="size-3.5" />
              Models
            </span>
          }
        >
          <div className="space-y-3">
            <Stat label="chat" value={health.models.chat} />
            <Stat label="grader (plan / grade / verify)" value={health.models.grader} />
            <Stat label="embedding" value={health.models.embedding} />
            <Stat label="web fallback" value={health.webSearch} />
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted">
            Set <code className="font-mono text-muted">LOCALMIND_CHAT_PROVIDER</code>,{' '}
            <code className="font-mono text-muted">LOCALMIND_CHAT_MODEL</code> and{' '}
            <code className="font-mono text-muted">LOCALMIND_GRADER_MODEL</code> in{' '}
            <code className="font-mono">.env</code>. Pointing the grader at a cheaper model is usually the best cost
            lever: it handles four of the six model calls in a clean Research run.
          </p>
        </Panel>

        <Panel
          title={
            <span className="flex items-center gap-1.5">
              <Sliders className="size-3.5" />
              Retrieval
            </span>
          }
        >
          <div className="grid grid-cols-3 gap-3">
            <Stat label="topK" value={health.retrieval.topK} />
            <Stat label="minScore" value={health.retrieval.minScore} />
            <Stat label="context budget" value={`${health.retrieval.maxContextTokens} tok`} />
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted">
            <code className="font-mono text-muted">LOCALMIND_TOP_K</code>,{' '}
            <code className="font-mono text-muted">LOCALMIND_MIN_SCORE</code>,{' '}
            <code className="font-mono text-muted">LOCALMIND_MAX_CONTEXT_TOKENS</code>. These are query-time only, so
            changing them needs no re-ingest.
          </p>
        </Panel>
      </div>

      <div className="space-y-3">
        <Panel
          title={
            <span className="flex items-center gap-1.5">
              <Database className="size-3.5" />
              Index
            </span>
          }
        >
          <div className="grid grid-cols-2 gap-3">
            <Stat label="documents" value={health.corpus.documents} />
            <Stat label="chunks" value={health.corpus.chunks} />
            <Stat label="dimensions" value={health.corpus.dimensions} />
            <Stat label="model" value={health.corpus.embeddingModel} />
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {Object.entries(health.corpus.byOrigin).map(([origin, count]) => (
              <Badge key={origin}>
                {origin} {count}
              </Badge>
            ))}
          </div>
        </Panel>

        <Panel
          title={
            <span className="flex items-center gap-1.5">
              <HardDrive className="size-3.5" />
              Storage
            </span>
          }
        >
          <div className="space-y-3">
            <Stat label="LanceDB path" value={health.store.dbPath} />
            <Stat label="chunk table" value={health.store.tableName} />
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted">
            A directory on disk — no server, no credentials, disposable. Changing the embedding model or the chunk size
            invalidates every vector, so both require a rebuild.
          </p>
        </Panel>

        <Panel
          title={
            <span className="flex items-center gap-1.5">
              <Settings2 className="size-3.5" />
              Available connectors
            </span>
          }
        >
          <ul className="space-y-1.5">
            {health.connectors.map((connector) => (
              <li key={connector.kind} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-fg">{connector.label}</span>
                <span className="flex items-center gap-1.5">
                  {connector.readsRowData ? (
                    <Badge tone="warn">samples data</Badge>
                  ) : (
                    <Badge tone="accent">schema only</Badge>
                  )}
                  {connector.driver !== undefined ? (
                    <code className="font-mono text-[10px] text-faint">{connector.driver}</code>
                  ) : (
                    <Badge>no driver</Badge>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
