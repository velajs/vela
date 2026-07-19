/**
 * The panel registry. Every real v1 panel loads through a true
 * `lazy(() => import('../panels/<x>'))` boundary, so the bundler emits one chunk
 * per panel and the routed `<Outlet>`'s `<Suspense>` is a real code-split seam.
 *
 * `transfer` (M9) intentionally keeps a lightweight stub — its panel lands in a
 * later milestone; the stub still resolves through `lazy`, so the router treats
 * every tab uniformly. `timeTravel` (M8b) is now a real code-split panel.
 */
import { lazy } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';
import { TAB_META } from './nav';
import type { StudioTab } from './nav';

/** The placeholder shown for tabs whose panels are owned by a later milestone. */
export function StubPanel({ tab }: { tab: StudioTab }) {
  const meta = TAB_META[tab];
  return (
    <section className="vela-panel" data-tab={tab}>
      <header className="vela-panel__head">
        <div>
          <h1 className="vela-panel__h1">{meta.label}</h1>
          <p className="vela-panel__desc">This panel lands in a later milestone.</p>
        </div>
      </header>
      <div className="vela-panel__body">
        <div className="vela-state vela-state--empty">
          <p className="vela-state__label">Panel: {tab}</p>
        </div>
      </div>
    </section>
  );
}

const stubLazy = (tab: StudioTab): LazyExoticComponent<ComponentType> =>
  lazy(async () => ({ default: () => <StubPanel tab={tab} /> }));

/**
 * Tab → lazy panel component. `satisfies Record<StudioTab, …>` enforces total
 * coverage (a new tab must be wired here), while each `import()` stays a static
 * literal so the bundler can split it into its own chunk.
 */
const PANELS = {
  home: lazy(() => import('../panels/home')),
  routes: lazy(() => import('../panels/routes')),
  modules: lazy(() => import('../panels/modules')),
  entrypoints: lazy(() => import('../panels/entrypoints')),
  api: lazy(() => import('../panels/api/index')),
  data: lazy(() => import('../panels/data/index')),
  timeTravel: lazy(() => import('../panels/time-travel')),
  transfer: stubLazy('transfer'),
  users: lazy(() => import('../panels/users')),
  sessions: lazy(() => import('../panels/sessions')),
  organizations: lazy(() => import('../panels/organizations')),
  queues: lazy(() => import('../panels/queues')),
  schedule: lazy(() => import('../panels/schedule')),
  flags: lazy(() => import('../panels/flags')),
  logs: lazy(() => import('../panels/logs')),
  live: lazy(() => import('../panels/live')),
  presence: lazy(() => import('../panels/presence')),
  audit: lazy(() => import('../panels/audit')),
} satisfies Record<StudioTab, LazyExoticComponent<ComponentType>>;

/** The lazy panel component for a tab. */
export function panelComponentFor(tab: StudioTab): LazyExoticComponent<ComponentType> {
  return PANELS[tab];
}
