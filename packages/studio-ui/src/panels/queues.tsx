/**
 * The queues panel: `queue.list` for the roster (name / kind), `queue.depths`
 * polled on an interval for live depth, and a per-queue dead-letter drawer
 * (`queue.dlq`). Send + replay affordances render only when `writes.opsEditable`
 * is open; the panel is read-first, mutations wired via `useAdminMutation`.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { DlqEntryRow } from '@velajs/studio-protocol';
import { useStudioCapabilities } from '../data/capabilities';
import { useAdminMutation, useAdminQuery } from '../data/query';
import { Panel, QueryView, Badge, Drawer, JsonBlock } from './shared';
import { EmptyState, AdminErrorView } from './shared';
import { formatTimestamp } from './format';

function DlqDrawer({
  queue,
  canReplay,
  onClose,
}: {
  queue: string | null;
  canReplay: boolean;
  onClose: () => void;
}): ReactNode {
  const dlq = useAdminQuery('queue.dlq', { queue: queue ?? '' }, { enabled: queue !== null });
  const replay = useAdminMutation('queue.replay', { invalidates: ['queue.dlq', 'queue.depths'] });

  const renderEntry = (entry: DlqEntryRow): ReactNode => (
    <div className="vela-dlq" key={entry.id}>
      <div className="vela-dlq__head">
        <span className="vela-mono">{entry.id}</span>
        <Badge tone="warn">{entry.attempts} attempts</Badge>
        <span className="vela-state__hint">{formatTimestamp(entry.failedAt)}</span>
      </div>
      {entry.error !== undefined ? <p className="vela-dlq__error">{entry.error}</p> : null}
      {entry.payload !== undefined ? <JsonBlock value={entry.payload} /> : null}
      {canReplay ? (
        <button
          type="button"
          className="vela-btn"
          disabled={replay.isPending}
          onClick={() => replay.mutate({ queue: entry.queue, ids: [entry.id] })}
        >
          Replay
        </button>
      ) : null}
    </div>
  );

  return (
    <Drawer open={queue !== null} title={`Dead letters · ${queue ?? ''}`} onClose={onClose}>
      {dlq.error !== null ? (
        <AdminErrorView error={dlq.error} />
      ) : dlq.data === undefined ? (
        <p className="vela-state__hint">Loading…</p>
      ) : dlq.data.length === 0 ? (
        <EmptyState label="No dead letters" hint="This queue has no failed messages." />
      ) : (
        dlq.data.map(renderEntry)
      )}
    </Drawer>
  );
}

export default function QueuesPanel(): ReactNode {
  const { capabilities } = useStudioCapabilities();
  const canOps = capabilities.writes.opsEditable;
  const canDepths = capabilities.operations.includes('queue.depths');
  const canDlq = capabilities.operations.includes('queue.dlq');
  const canSend = canOps && capabilities.operations.includes('queue.send');
  const canReplay = canOps && capabilities.operations.includes('queue.replay');
  const [dlqQueue, setDlqQueue] = useState<string | null>(null);

  const list = useAdminQuery('queue.list', {});
  const depths = useAdminQuery('queue.depths', {}, { refetchInterval: 3_000, enabled: canDepths });
  const send = useAdminMutation('queue.send', { invalidates: ['queue.depths'] });

  const depthByName = new Map((depths.data ?? []).map((d) => [d.name, d]));

  return (
    <Panel title="Queues" description="Message queues, live depth, and dead letters.">
      <QueryView result={list} isEmpty={(rows) => rows.length === 0} emptyLabel="No queues.">
        {(rows) => (
          <table className="vela-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Depth</th>
                <th>In flight</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const live = depthByName.get(row.name);
                return (
                  <tr key={row.name}>
                    <td className="vela-mono">{row.name}</td>
                    <td>
                      <Badge tone="neutral">{row.kind}</Badge>
                    </td>
                    <td>{live?.depth ?? row.depth ?? '—'}</td>
                    <td>{live?.inFlight ?? '—'}</td>
                    <td className="vela-actions">
                      {canDlq ? (
                        <button
                          type="button"
                          className="vela-btn"
                          onClick={() => setDlqQueue(row.name)}
                        >
                          Dead letters
                        </button>
                      ) : null}
                      {canSend ? (
                        <button
                          type="button"
                          className="vela-btn"
                          disabled={send.isPending}
                          onClick={() => send.mutate({ queue: row.name, payload: { test: true } })}
                        >
                          Send test
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </QueryView>
      <DlqDrawer queue={dlqQueue} canReplay={canReplay} onClose={() => setDlqQueue(null)} />
    </Panel>
  );
}
