/**
 * The flags panel: `flags.list` renders each flag's key and its typed value
 * (boolean / string / number / object), and an evaluate drawer takes a JSON
 * targeting context to `flags.evaluate`, showing the resolved value, reason, and
 * any error message.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { FlagValue } from '@velajs/studio-protocol';
import { useAdminMutation, useAdminQuery } from '../data/query';
import { Panel, QueryView, Badge, Drawer, JsonBlock } from './shared';
import type { BadgeTone } from './shared';

function ValueCell({ value }: { value: FlagValue }): ReactNode {
  if (typeof value === 'boolean') {
    return <Badge tone={value ? 'success' : 'muted'}>{String(value)}</Badge>;
  }
  if (typeof value === 'number') return <span className="vela-mono">{value}</span>;
  if (typeof value === 'string') return <span className="vela-mono">"{value}"</span>;
  return <JsonBlock value={value} />;
}

const REASON_TONE: Record<string, BadgeTone> = {
  STATIC: 'success',
  DEFAULT: 'muted',
  ERROR: 'danger',
};

function EvaluateDrawer({
  flagKey,
  onClose,
}: {
  flagKey: string | null;
  onClose: () => void;
}): ReactNode {
  const [context, setContext] = useState('{\n  "userId": "u_ada"\n}');
  const evaluate = useAdminMutation('flags.evaluate');

  const run = (): void => {
    if (flagKey === null) return;
    let parsed: Record<string, unknown> | undefined;
    try {
      const value: unknown = JSON.parse(context);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      parsed = undefined;
    }
    evaluate.mutate(parsed !== undefined ? { key: flagKey, context: parsed } : { key: flagKey });
  };

  return (
    <Drawer open={flagKey !== null} title={`Evaluate · ${flagKey ?? ''}`} onClose={onClose}>
      <label className="vela-login__label" htmlFor="vela-flag-ctx">
        Targeting context (JSON)
      </label>
      <textarea
        id="vela-flag-ctx"
        className="vela-textarea"
        aria-label="Targeting context"
        value={context}
        onChange={(event) => setContext(event.target.value)}
      />
      <button type="button" className="vela-btn vela-btn--primary" onClick={run}>
        Evaluate
      </button>
      {evaluate.data !== undefined ? (
        <div className="vela-eval">
          <div className="vela-eval__row">
            <span className="vela-eval__label">value</span>
            <ValueCell value={evaluate.data.value} />
          </div>
          <div className="vela-eval__row">
            <span className="vela-eval__label">reason</span>
            <Badge tone={REASON_TONE[evaluate.data.reason] ?? 'neutral'}>
              {evaluate.data.reason}
            </Badge>
          </div>
          {evaluate.data.errorMessage !== undefined ? (
            <p className="vela-state__message">{evaluate.data.errorMessage}</p>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}

export default function FlagsPanel(): ReactNode {
  const [selected, setSelected] = useState<string | null>(null);
  const result = useAdminQuery('flags.list', {});
  return (
    <Panel title="Flags" description="Feature flags and their resolved values.">
      <QueryView result={result} isEmpty={(rows) => rows.length === 0} emptyLabel="No flags.">
        {(rows) => (
          <table className="vela-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Value</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((flag) => (
                <tr key={flag.key}>
                  <td className="vela-mono">{flag.key}</td>
                  <td>
                    <ValueCell value={flag.value} />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="vela-btn"
                      onClick={() => setSelected(flag.key)}
                    >
                      Evaluate
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </QueryView>
      <EvaluateDrawer flagKey={selected} onClose={() => setSelected(null)} />
    </Panel>
  );
}
