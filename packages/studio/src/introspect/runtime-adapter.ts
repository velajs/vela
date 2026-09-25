/**
 * `studioRuntimeAdapter` — the OPT-IN route-attribution binding (from the M4
 * review).
 *
 * The `app.routes` op reads the live Hono table via the {@link StudioAppHolder},
 * which cannot attribute a row to its `Controller#handler` (that lives on the
 * barrel-internal `RouteManager`). This `RuntimeAdapter`'s `onRoutesBuilt` hook
 * runs after routes are built with the framework's own `VelaApplication`, so it
 * can call the PUBLIC `describeRoutes()` — the fully-attributed
 * `RouteDescription[]` — and deposit it in the holder. The app opts in via:
 *
 * ```ts
 * const app = await VelaFactory.create(AppModule, { adapters: [studioRuntimeAdapter] });
 * ```
 *
 * With it wired, `app.routes` reports real controller/handler/`source:
 * 'controller'`; without it, the holder's mount-time Hono capture is the
 * fallback and every row keeps the honest `(mounted)` degradation.
 */
import type { AdapterContext, RuntimeAdapter } from '@velajs/vela/module-kit';
import { StudioAppHolder } from './app-holder';
import { StudioAdminController } from '../http/route-contributor';
import { declaringModuleId } from '../http/studio-scope';

/**
 * The Studio runtime adapter. Deposits `ctx.app.describeRoutes()` into the
 * {@link StudioAppHolder} of the app's StudioModule once routes are built. A
 * no-op when Studio is not in the graph (the holder is unbound), so it is
 * always safe to include.
 */
export const studioRuntimeAdapter: RuntimeAdapter = {
  name: '@velajs/studio/route-attribution',
  onRoutesBuilt(ctx: AdapterContext): void {
    if (!ctx.container.has(StudioAppHolder)) return;
    const studio = declaringModuleId(ctx.container, StudioAdminController);
    ctx.container
      .resolve(StudioAppHolder, studio)
      .captureRouteDescriptions(ctx.app.describeRoutes());
  },
};
