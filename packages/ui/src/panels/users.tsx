/**
 * The auth users panel: a searchable, cursor-paginated table over `auth.users`.
 * Selecting a row opens the `auth.userDetail` drawer (the user plus their
 * sessions and organizations). Read-only — no user mutations in this milestone.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { AuthUserRow } from '@velajs/studio-protocol';
import { useAdminQuery } from '../data/query';
import { Panel, QueryView, Badge, Drawer, KeyValueList } from './shared';
import { AdminErrorView } from './shared';
import { formatTimestamp } from './format';

function UserDetailDrawer({ id, onClose }: { id: string | null; onClose: () => void }): ReactNode {
  const detail = useAdminQuery('auth.userDetail', { id: id ?? '' }, { enabled: id !== null });
  return (
    <Drawer open={id !== null} title="User" onClose={onClose}>
      {detail.error !== null ? (
        <AdminErrorView error={detail.error} />
      ) : detail.data === undefined ? (
        <p className="vela-state__hint">Loading…</p>
      ) : (
        <div className="vela-userdetail">
          <KeyValueList
            rows={[
              ['id', <span className="vela-mono">{detail.data.user.id}</span>],
              ['email', detail.data.user.email],
              ['name', detail.data.user.name ?? '—'],
              ['role', detail.data.user.role ?? '—'],
              ['verified', detail.data.user.emailVerified ? 'yes' : 'no'],
              ['sessions', String(detail.data.sessions.length)],
              ['organizations', String(detail.data.organizations.length)],
            ]}
          />
        </div>
      )}
    </Drawer>
  );
}

function UsersTable({
  rows,
  onSelect,
}: {
  rows: AuthUserRow[];
  onSelect: (id: string) => void;
}): ReactNode {
  return (
    <table className="vela-table">
      <thead>
        <tr>
          <th>Email</th>
          <th>Name</th>
          <th>Role</th>
          <th>Verified</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="vela-table__clickable" onClick={() => onSelect(row.id)}>
            <td className="vela-mono">
              {row.email}
              {row.banned === true ? (
                <>
                  {' '}
                  <Badge tone="danger">banned</Badge>
                </>
              ) : null}
            </td>
            <td>{row.name ?? '—'}</td>
            <td>{row.role !== undefined ? <Badge tone="neutral">{row.role}</Badge> : '—'}</td>
            <td>{row.emailVerified ? 'yes' : 'no'}</td>
            <td className="vela-mono">{formatTimestamp(row.createdAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function UsersPanel(): ReactNode {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);

  const args = cursor !== undefined ? { q: query, cursor } : { q: query };
  const result = useAdminQuery('auth.users', args, { keepPreviousData: true });

  return (
    <Panel title="Users" description="Accounts registered with the auth provider.">
      <div className="vela-toolbar">
        <input
          className="vela-input"
          type="search"
          aria-label="Search users"
          placeholder="Search email or name…"
          value={query}
          onChange={(event) => {
            setCursor(undefined);
            setQuery(event.target.value);
          }}
        />
      </div>
      <QueryView
        result={result}
        isEmpty={(page) => page.rows.length === 0}
        emptyLabel="No users match."
      >
        {(page) => (
          <>
            <UsersTable rows={page.rows} onSelect={setSelected} />
            <div className="vela-pager">
              <span className="vela-pager__info">{page.rows.length} shown</span>
              <div className="vela-pager__controls">
                <button
                  type="button"
                  className="vela-btn"
                  disabled={cursor === undefined}
                  onClick={() => setCursor(undefined)}
                >
                  First page
                </button>
                <button
                  type="button"
                  className="vela-btn"
                  disabled={page.nextCursor === undefined}
                  onClick={() => setCursor(page.nextCursor)}
                >
                  Next page
                </button>
              </div>
            </div>
          </>
        )}
      </QueryView>
      <UserDetailDrawer id={selected} onClose={() => setSelected(null)} />
    </Panel>
  );
}
