/**
 * The audit panel: a table over `audit.tail` (timestamp, op, mode, subject,
 * status, duration) with a read/write mode filter.
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { AdminAuditEntry } from '@velajs/studio-protocol';
import { useAdminQuery } from '../data/query';
import { Panel, QueryView, Badge } from './shared';
import { formatTimestamp } from './format';

const MODES = ['all', 'read', 'write'] as const;
type ModeFilter = (typeof MODES)[number];

function AuditTable({ rows, mode }: { rows: AdminAuditEntry[]; mode: ModeFilter }): ReactNode {
  const filtered = useMemo(
    () => (mode === 'all' ? rows : rows.filter((row) => row.mode === mode)),
    [rows, mode],
  );
  return (
    <table className="vela-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Op</th>
          <th>Mode</th>
          <th>Subject</th>
          <th>Status</th>
          <th>ms</th>
        </tr>
      </thead>
      <tbody>
        {filtered.map((row, index) => (
          <tr key={`${row.ts}-${row.op}-${index}`}>
            <td className="vela-mono">{formatTimestamp(row.ts)}</td>
            <td className="vela-mono">{row.op}</td>
            <td>
              <Badge tone={row.mode === 'write' ? 'warn' : 'neutral'}>{row.mode}</Badge>
            </td>
            <td>{row.subject}</td>
            <td>
              <Badge tone={row.status < 400 ? 'success' : 'danger'}>{row.status}</Badge>
            </td>
            <td className="vela-mono">{row.ms}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function AuditPanel(): ReactNode {
  const [mode, setMode] = useState<ModeFilter>('all');
  const result = useAdminQuery('audit.tail', {});
  return (
    <Panel title="Audit" description="A tail of recorded admin operations.">
      <div className="vela-toolbar">
        <div className="vela-tabs" role="tablist" aria-label="Audit mode">
          {MODES.map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={mode === option}
              className="vela-tabs__tab"
              data-active={mode === option ? 'true' : undefined}
              onClick={() => setMode(option)}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
      <QueryView result={result} isEmpty={(rows) => rows.length === 0} emptyLabel="No audit rows.">
        {(rows) => <AuditTable rows={rows} mode={mode} />}
      </QueryView>
    </Panel>
  );
}
