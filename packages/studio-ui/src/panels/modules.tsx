/**
 * The modules panel: a list over `app.modules`. Each row shows the module id,
 * `lazy`/`isGlobal` badges, and provider/export/import counts; expanding a row
 * reveals its import edges and the token labels it registers and exports.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ModuleNode } from '@velajs/studio-protocol';
import { useAdminQuery } from '../data/query';
import { Panel, QueryView, Badge } from './shared';

function TokenList({ label, tokens }: { label: string; tokens: string[] }): ReactNode {
  return (
    <div className="vela-module__tokens">
      <span className="vela-module__tokens-label">{label}</span>
      {tokens.length === 0 ? (
        <span className="vela-state__hint">none</span>
      ) : (
        <ul className="vela-module__token-list">
          {tokens.map((token) => (
            <li key={token} className="vela-mono">
              {token}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ModuleRow({ node }: { node: ModuleNode }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <li className="vela-module">
      <button
        type="button"
        className="vela-module__head"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="vela-module__caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="vela-module__id vela-mono">{node.moduleId}</span>
        <span className="vela-module__badges">
          {node.isGlobal ? <Badge tone="accent">global</Badge> : null}
          {node.lazy ? <Badge tone="muted">lazy</Badge> : null}
          <Badge tone="neutral">{node.providers.length} providers</Badge>
          <Badge tone="neutral">{node.exports.length} exports</Badge>
          <Badge tone="neutral">{node.imports.length} imports</Badge>
        </span>
      </button>
      {open ? (
        <div className="vela-module__detail">
          <TokenList label="imports" tokens={node.imports} />
          <TokenList label="providers" tokens={node.providers} />
          <TokenList label="exports" tokens={node.exports} />
        </div>
      ) : null}
    </li>
  );
}

export default function ModulesPanel(): ReactNode {
  const result = useAdminQuery('app.modules', {});
  return (
    <Panel title="Modules" description="The loaded module graph and its dependency edges.">
      <QueryView result={result} isEmpty={(rows) => rows.length === 0} emptyLabel="No modules.">
        {(rows) => (
          <ul className="vela-module-list">
            {rows.map((node) => (
              <ModuleRow key={node.moduleId} node={node} />
            ))}
          </ul>
        )}
      </QueryView>
    </Panel>
  );
}
