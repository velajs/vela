/**
 * The logs panel: `logs.tail` polled on an interval, with level filter tabs, a
 * limit selector, an auto-scroll toggle, and dense monospace rows whose
 * structured `fields` expand on click.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AdminLogEntry } from '@velajs/studio-protocol';
import { useAdminQuery } from '../data/query';
import { Panel, QueryView, Badge, JsonBlock } from './shared';
import type { BadgeTone } from './shared';
import { formatClock } from './format';

const LEVELS = ['all', 'debug', 'info', 'warn', 'error'] as const;
type LevelFilter = (typeof LEVELS)[number];

const LIMITS = [50, 100, 250, 500];

const LEVEL_TONE: Record<AdminLogEntry['level'], BadgeTone> = {
  debug: 'muted',
  info: 'neutral',
  warn: 'warn',
  error: 'danger',
};

function LogRow({ entry }: { entry: AdminLogEntry }): ReactNode {
  const [open, setOpen] = useState(false);
  const hasFields = entry.fields !== undefined && Object.keys(entry.fields).length > 0;
  const hasDetails = hasFields || entry.invocation !== undefined;
  return (
    <li className="vela-log">
      <button
        type="button"
        className="vela-log__line"
        aria-expanded={hasDetails ? open : undefined}
        onClick={() => hasDetails && setOpen((prev) => !prev)}
      >
        <span className="vela-log__ts vela-mono">{formatClock(entry.ts)}</span>
        <Badge tone={LEVEL_TONE[entry.level]}>{entry.level}</Badge>
        {entry.source !== undefined ? (
          <span className="vela-log__source">{entry.source}</span>
        ) : null}
        <span className="vela-log__msg vela-mono">{entry.msg}</span>
        {entry.invocation !== undefined ? (
          <Badge tone="neutral">{entry.invocation.elapsedMs.toFixed(2)} ms</Badge>
        ) : null}
      </button>
      {open && entry.invocation !== undefined ? (
        <div className="vela-state__hint">
          <p>
            {entry.invocation.kind}: {entry.invocation.source} — {entry.invocation.outcome}
          </p>
          <p>
            Invocation: {entry.invocation.invocationId ?? 'Unavailable'}; owner:{' '}
            {entry.invocation.moduleId ?? 'Not supplied'}.
          </p>
          <p>
            Handler and inner interceptor time. Excludes guards, argument validation, response
            streaming and deferred work.
          </p>
        </div>
      ) : null}
      {open && hasFields ? <JsonBlock value={entry.fields} /> : null}
    </li>
  );
}

export default function LogsPanel(): ReactNode {
  const [level, setLevel] = useState<LevelFilter>('all');
  const [limit, setLimit] = useState(100);
  const [autoScroll, setAutoScroll] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  const args = level === 'all' ? { limit } : { level, limit };
  const result = useAdminQuery('logs.tail', args, {
    refetchInterval: 2_000,
    keepPreviousData: true,
  });

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [autoScroll, result.data]);

  return (
    <Panel
      title="Logs"
      description="Recent application log lines (polled)."
      actions={
        <label className="vela-check">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(event) => setAutoScroll(event.target.checked)}
          />
          <span>Auto-scroll</span>
        </label>
      }
    >
      <div className="vela-toolbar">
        <div className="vela-tabs" role="tablist" aria-label="Log level">
          {LEVELS.map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={level === option}
              className="vela-tabs__tab"
              data-active={level === option ? 'true' : undefined}
              onClick={() => setLevel(option)}
            >
              {option}
            </button>
          ))}
        </div>
        <select
          className="vela-select"
          aria-label="Log limit"
          value={limit}
          onChange={(event) => setLimit(Number(event.target.value) || 100)}
        >
          {LIMITS.map((n) => (
            <option key={n} value={n}>
              last {n}
            </option>
          ))}
        </select>
      </div>
      <QueryView result={result} isEmpty={(rows) => rows.length === 0} emptyLabel="No log lines.">
        {(rows) => (
          <ul className="vela-logs">
            {rows.map((entry, index) => (
              <LogRow key={`${entry.ts}-${index}`} entry={entry} />
            ))}
            <div ref={bottomRef} />
          </ul>
        )}
      </QueryView>
    </Panel>
  );
}
