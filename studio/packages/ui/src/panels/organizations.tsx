/**
 * The organizations panel: a table over `auth.organizations` (better-auth
 * organization plugin). Read-only.
 */
import type { ReactNode } from 'react';
import { useAdminQuery } from '../data/query';
import { Panel, QueryView } from './shared';
import { formatTimestamp } from './format';

export default function OrganizationsPanel(): ReactNode {
  const result = useAdminQuery('auth.organizations', {});
  return (
    <Panel title="Organizations" description="Tenants registered with the organization plugin.">
      <QueryView
        result={result}
        isEmpty={(rows) => rows.length === 0}
        emptyLabel="No organizations."
      >
        {(rows) => (
          <table className="vela-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Slug</th>
                <th>Members</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td className="vela-mono">{row.slug ?? '—'}</td>
                  <td>{row.memberCount ?? '—'}</td>
                  <td className="vela-mono">{formatTimestamp(row.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </QueryView>
    </Panel>
  );
}
