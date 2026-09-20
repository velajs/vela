/**
 * The routes panel: a filterable table over `app.routes`. Method badge, path,
 * handler, and source; a client-side substring filter; and an honest note when
 * any row is `(mounted)`-degraded (a route vela did not compose itself, so its
 * handler is opaque).
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { RouteRow } from '@velajs/studio-protocol';
import { useAdminQuery } from '../data/query';
import { Panel, QueryView, Badge } from './shared';
import type { BadgeTone } from './shared';

const METHOD_TONE: Record<string, BadgeTone> = {
  GET: 'success',
  POST: 'accent',
  PUT: 'warn',
  PATCH: 'warn',
  DELETE: 'danger',
};

function RoutesTable({ rows }: { rows: RouteRow[] }): ReactNode {
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      needle === ''
        ? rows
        : rows.filter(
            (row) =>
              row.path.toLowerCase().includes(needle) ||
              row.handler.toLowerCase().includes(needle) ||
              row.method.toLowerCase().includes(needle),
          ),
    [rows, needle],
  );
  const degraded = rows.filter((row) => row.source === 'mounted').length;

  return (
    <>
      <div className="vela-toolbar">
        <input
          className="vela-input"
          type="search"
          aria-label="Filter routes"
          placeholder="Filter routes…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <span className="vela-toolbar__count">
          {filtered.length} / {rows.length}
        </span>
      </div>
      {degraded > 0 ? (
        <p className="vela-note">
          {degraded} {degraded === 1 ? 'route is' : 'routes are'} mounted (composed outside vela) —
          their handler is reported as <code>(mounted)</code>.
        </p>
      ) : null}
      <table className="vela-table">
        <thead>
          <tr>
            <th>Method</th>
            <th>Path</th>
            <th>Handler</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((row, index) => (
            <tr key={`${row.method}-${row.path}-${index}`}>
              <td>
                <Badge tone={METHOD_TONE[row.method] ?? 'neutral'}>{row.method}</Badge>
              </td>
              <td className="vela-mono">{row.path}</td>
              <td className="vela-mono">{row.handler}</td>
              <td>
                <Badge tone={row.source === 'mounted' ? 'muted' : 'neutral'}>{row.source}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export default function RoutesPanel(): ReactNode {
  const result = useAdminQuery('app.routes', {});
  return (
    <Panel title="Routes" description="Every HTTP route the app exposes.">
      <QueryView result={result} isEmpty={(rows) => rows.length === 0} emptyLabel="No routes.">
        {(rows) => <RoutesTable rows={rows} />}
      </QueryView>
    </Panel>
  );
}
