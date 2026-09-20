/**
 * The presence panel: a polled table over `presence.rooms` — occupancy per room
 * with a sampled member list.
 */
import type { ReactNode } from 'react';
import { useAdminQuery } from '../data/query';
import { Panel, QueryView, Badge } from './shared';

export default function PresencePanel(): ReactNode {
  const result = useAdminQuery('presence.rooms', {}, { refetchInterval: 3_000 });
  return (
    <Panel title="Presence" description="Room occupancy (polled).">
      <QueryView
        result={result}
        isEmpty={(rows) => rows.length === 0}
        emptyLabel="No occupied rooms."
      >
        {(rows) => (
          <table className="vela-table">
            <thead>
              <tr>
                <th>Room</th>
                <th>Count</th>
                <th>Members</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.room}>
                  <td className="vela-mono">{row.room}</td>
                  <td>
                    <Badge tone="accent">{row.count}</Badge>
                  </td>
                  <td className="vela-tags">
                    {(row.members ?? []).map((member) => (
                      <Badge key={member} tone="neutral">
                        {member}
                      </Badge>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </QueryView>
    </Panel>
  );
}
