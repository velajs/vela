/**
 * Placeholder panels (one per tab). M6 owns the real panel UI; here each tab
 * renders its id + a cheap `useStudioCapabilities` readout, wrapped as a
 * `React.lazy` boundary so the routed `<Outlet>`'s `<Suspense>` is exercised.
 */
import { lazy } from 'react';
import { useStudioCapabilities } from '../data/capabilities';
import { TAB_META } from './nav';
import type { StudioTab } from './nav';

export function PanelStub({ tab }: { tab: StudioTab }) {
  const { capabilities, isLoading } = useStudioCapabilities();
  const meta = TAB_META[tab];
  const featureLive = capabilities.features[meta.feature];
  return (
    <section className="vela-panel" data-tab={tab} aria-labelledby={`vela-panel-title-${tab}`}>
      <h2 id={`vela-panel-title-${tab}`} className="vela-panel__title">
        {meta.label}
      </h2>
      <p className="vela-panel__id">Panel: {tab}</p>
      <dl className="vela-panel__caps">
        <div className="vela-panel__cap">
          <dt>feature</dt>
          <dd>
            {meta.feature}: {String(featureLive)}
          </dd>
        </div>
        <div className="vela-panel__cap">
          <dt>capabilities</dt>
          <dd>{isLoading ? 'loading…' : 'ready'}</dd>
        </div>
      </dl>
      <p className="vela-panel__note">Real panel lands in M6.</p>
    </section>
  );
}

/**
 * A `React.lazy` stub for a tab. The stubs resolve synchronously (no real
 * `import()`), but stay lazy so the shell's `<Suspense>` path is real and
 * testable.
 */
export function lazyPanel(tab: StudioTab) {
  return lazy(async () => ({ default: () => <PanelStub tab={tab} /> }));
}
