/**
 * The live panel: a polled table over `live.subscriptions` — each active
 * subscription's room, tags, client, and connection time.
 */
import type { ReactNode } from 'react';
import { useAdminQuery } from '../data/query';
import { Panel, QueryView, Badge } from './shared';
import { formatTimestamp } from './format';

export default function LivePanel(): ReactNode {
  const result = useAdminQuery('live.subscriptions', {}, { refetchInterval: 3_000 });
  return (
    <Panel title="Live" description="Active live-query subscriptions (polled).">
      <QueryView
        result={result}
        isEmpty={(rows) => rows.length === 0}
        emptyLabel="No active subscriptions."
      >
        {(rows) => (
          <table className="vela-table">
            <thead>
              <tr>
                <th>Subscription</th>
                <th>Room</th>
                <th>Tags</th>
                <th>Client</th>
                <th>Connected</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="vela-mono">{row.id}</td>
                  <td className="vela-mono">{row.room}</td>
                  <td className="vela-tags">
                    {row.tags.map((tag) => (
                      <Badge key={tag} tone="neutral">
                        {tag}
                      </Badge>
                    ))}
                  </td>
                  <td className="vela-mono">{row.clientId ?? '—'}</td>
                  <td className="vela-mono">{formatTimestamp(row.connectedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </QueryView>
    </Panel>
  );
}
