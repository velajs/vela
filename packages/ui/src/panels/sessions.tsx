/**
 * The auth sessions panel: a table over `auth.sessions`. A per-row revoke button
 * (calling `auth.revokeSession` via `useAdminMutation`) renders only when
 * `writes.opsEditable` is open — the panel is read-first, so a read-only Studio
 * shows no revoke affordance at all.
 */
import type { ReactNode } from 'react';
import type { AuthSessionRow } from '@velajs/studio-protocol';
import { useStudioCapabilities } from '../data/capabilities';
import { useAdminMutation, useAdminQuery } from '../data/query';
import { Panel, QueryView } from './shared';
import { formatTimestamp } from './format';

function SessionsTable({
  rows,
  canRevoke,
}: {
  rows: AuthSessionRow[];
  canRevoke: boolean;
}): ReactNode {
  const revoke = useAdminMutation('auth.revokeSession', { invalidates: ['auth.sessions'] });
  return (
    <table className="vela-table">
      <thead>
        <tr>
          <th>Session</th>
          <th>User</th>
          <th>IP</th>
          <th>Created</th>
          <th>Expires</th>
          {canRevoke ? <th>Actions</th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td className="vela-mono">{row.id}</td>
            <td className="vela-mono">{row.userId}</td>
            <td className="vela-mono">{row.ipAddress ?? '—'}</td>
            <td className="vela-mono">{formatTimestamp(row.createdAt)}</td>
            <td className="vela-mono">{formatTimestamp(row.expiresAt)}</td>
            {canRevoke ? (
              <td>
                <button
                  type="button"
                  className="vela-btn vela-btn--danger"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate({ sessionId: row.id })}
                >
                  Revoke
                </button>
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function SessionsPanel(): ReactNode {
  const { capabilities } = useStudioCapabilities();
  const canRevoke = capabilities.writes.opsEditable;
  const result = useAdminQuery('auth.sessions', {});
  return (
    <Panel title="Sessions" description="Active auth sessions.">
      <QueryView
        result={result}
        isEmpty={(rows) => rows.length === 0}
        emptyLabel="No active sessions."
      >
        {(rows) => <SessionsTable rows={rows} canRevoke={canRevoke} />}
      </QueryView>
    </Panel>
  );
}
