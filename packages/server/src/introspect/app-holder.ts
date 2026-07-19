/**
 * Mount-time capture seam for data the app graph does NOT expose through a
 * public DI token. The framework's `RouteManager` (which owns the composed
 * route table and the global prefix) is registered in the container but is
 * NOT re-exported from the public `@velajs/vela` barrel, so a provider cannot
 * author against it under the openness rule. The route contributor, however,
 * receives the live Hono instance and the resolved global prefix in
 * `buildRoutes(app, ctx)` — it deposits both here so the introspection ops can
 * read the final route table at dispatch time.
 *
 * Prefer public DI seams over this holder wherever both exist:
 *   - `app.modules`      → `Container.getModuleDescriptions()` (public).
 *   - `app.entrypoints`  → `EntrypointRegistry` (public global token).
 *   - `app.routes`       → ONLY reachable here (RouteManager is internal).
 */
import type { Hono } from 'hono';
import type { RouteDescription } from '@velajs/vela';

/**
 * A per-app singleton the route contributor populates once, at mount time.
 * Holds a reference to the live Hono app (not a snapshot), so reading
 * {@link app}`.routes` at dispatch time observes the fully-built table.
 *
 * OPT-IN route attribution (M9): the live Hono table cannot attribute a row to
 * its `Controller#handler` (that lives on the barrel-internal `RouteManager`),
 * so `app.routes` degrades every row to `(mounted)`. When the app wires the
 * {@link import('./runtime-adapter').studioRuntimeAdapter} via
 * `VelaFactory.create(App, { adapters: [studioRuntimeAdapter] })`, its
 * `onRoutesBuilt` hook deposits the fully-attributed `RouteDescription[]` here
 * (`ctx.app.describeRoutes()`), and the collector reports real handler/source.
 * Without the adapter the mount-time Hono capture is the fallback (unchanged).
 */
export class StudioAppHolder {
  private honoApp: Hono | null = null;
  private prefix = '';
  private descriptions: RouteDescription[] | null = null;

  /** Called once by the route contributor's `buildRoutes`. */
  capture(app: Hono, globalPrefix: string): void {
    this.honoApp = app;
    this.prefix = globalPrefix;
  }

  /** Called by {@link studioRuntimeAdapter}'s `onRoutesBuilt` when the adapter is wired. */
  captureRouteDescriptions(descriptions: RouteDescription[]): void {
    this.descriptions = descriptions;
  }

  /** The live Hono app, or null before the contributor has mounted. */
  get app(): Hono | null {
    return this.honoApp;
  }

  /** The app's normalized global prefix ('' when none), or '' before capture. */
  get globalPrefix(): string {
    return this.prefix;
  }

  /** The fully-attributed route descriptions, or null when the adapter isn't wired. */
  get routeDescriptions(): RouteDescription[] | null {
    return this.descriptions;
  }
}
