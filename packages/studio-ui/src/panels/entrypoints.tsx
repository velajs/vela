/**
 * The entrypoints panel: a table over `app.entrypoints` grouped by kind
 * (queue / cron / http / …). The empty state explains what entrypoints are, so
 * an app with none isn't mistaken for a broken panel.
 */
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { EntrypointRow } from '@velajs/studio-protocol';
import { useAdminQuery } from '../data/query';
import { Panel, QueryView, Badge, JsonBlock } from './shared';

function groupByKind(rows: EntrypointRow[]): Array<[string, EntrypointRow[]]> {
  const groups = new Map<string, EntrypointRow[]>();
  for (const row of rows) {
    const bucket = groups.get(row.kind);
    if (bucket === undefined) groups.set(row.kind, [row]);
    else bucket.push(row);
  }
  return [...groups.entries()].toSorted((a, b) => a[0].localeCompare(b[0]));
}

function EntrypointGroups({ rows }: { rows: EntrypointRow[] }): ReactNode {
  const groups = useMemo(() => groupByKind(rows), [rows]);
  return (
    <div className="vela-entrypoints">
      {groups.map(([kind, entries]) => (
        <section className="vela-card" key={kind}>
          <h2 className="vela-card__title">
            {kind} <Badge tone="neutral">{entries.length}</Badge>
          </h2>
          <table className="vela-table">
            <thead>
              <tr>
                <th>Target</th>
                <th>Owner / scope</th>
                <th>Meta</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, index) => (
                <tr key={`${entry.target}-${index}`}>
                  <td className="vela-mono">{entry.target}</td>
                  <td>
                    <span className="vela-mono">{entry.moduleId ?? 'Not supplied'}</span>
                    {entry.scope !== undefined ? <Badge tone="neutral">{entry.scope}</Badge> : null}
                  </td>
                  <td>
                    {entry.meta === undefined ? (
                      <span className="vela-state__hint">—</span>
                    ) : (
                      <JsonBlock value={entry.meta} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

export default function EntrypointsPanel(): ReactNode {
  const result = useAdminQuery('app.entrypoints', {});
  return (
    <Panel
      title="Entrypoints"
      description="Non-HTTP work the app registers: queues, cron jobs, and more."
    >
      <QueryView
        result={result}
        isEmpty={(rows) => rows.length === 0}
        emptyLabel="No entrypoints."
        emptyHint="Entrypoints are queue consumers, cron jobs, and other triggers the app declares outside the HTTP router."
      >
        {(rows) => <EntrypointGroups rows={rows} />}
      </QueryView>
    </Panel>
  );
}
