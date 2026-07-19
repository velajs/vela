/**
 * Builds the Studio router: a root route rendering {@link StudioLayout} around a
 * `<Suspense>`-wrapped `<Outlet>`, one child route per tab (each a `React.lazy`
 * stub), and a not-found route that redirects home. Defaults to an in-memory
 * history so embedding never hijacks the host app's URL bar.
 */
import { Suspense, useEffect } from 'react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useNavigate,
} from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';
import { StudioLayout } from './layout';
import { lazyPanel } from './panels';
import { NAV_GROUPS, tabPath } from './nav';

function RootLayout() {
  return (
    <StudioLayout>
      <Suspense fallback={<div className="vela-panel vela-panel--loading">Loading…</div>}>
        <Outlet />
      </Suspense>
    </StudioLayout>
  );
}

function RedirectHome() {
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({ to: '/', replace: true });
  }, [navigate]);
  return null;
}

export interface StudioRouterOptions {
  /**
   * Router basepath — the sub-path the SPA is mounted under in the browser.
   * This is the SPA mount path, never the server admin-mount prefix.
   */
  routerBasePath?: string;
  /** Supply a history; defaults to a memory history at {@link initialPath}. */
  history?: RouterHistory;
  /** Initial path for the default memory history (tests / deep links). */
  initialPath?: string;
}

export function createStudioRouter(options: StudioRouterOptions = {}) {
  const rootRoute = createRootRoute({ component: RootLayout, notFoundComponent: RedirectHome });

  const tabs = NAV_GROUPS.flatMap((group) => group.tabs);
  const routes = tabs.map((tab) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: tabPath(tab),
      component: lazyPanel(tab),
    }),
  );

  const routeTree = rootRoute.addChildren(routes);
  const history =
    options.history ?? createMemoryHistory({ initialEntries: [options.initialPath ?? '/'] });

  return createRouter({
    routeTree,
    history,
    basepath: options.routerBasePath,
    defaultPreload: false,
  });
}
