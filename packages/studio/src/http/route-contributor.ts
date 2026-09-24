/**
 * The Studio route contributor. A `RouteContributor` claims the marker
 * controller {@link StudioAdminController} by class-level metadata
 * (`STUDIO_ADMIN_META`) and mounts the admin surface in `RouteManager`'s
 * second pass (after explicit routes, so nothing is shadowed).
 *
 * Registration is an import-time side effect — the same idiom `@velajs/crud`
 * uses for its bridge. `StudioModule` imports {@link StudioAdminController}
 * from here, so importing the module pulls this file (and its
 * `registerRouteContributor` call) into the graph even under
 * `sideEffects: false`.
 */
import { Controller } from '@velajs/vela';
import { defineMetadata, registerRouteContributor } from '@velajs/vela/module-kit';
import type { RouteContributor } from '@velajs/vela/module-kit';
import { STUDIO_DEFAULT_PATH } from '@velajs/studio-protocol';
import { STUDIO_ADMIN_META } from '../tokens';
import { StudioAppHolder } from '../introspect/app-holder';
import { mountAdminRouter } from './admin-router';

/**
 * Marker controller claimed by the contributor. It declares no routes of its
 * own; the contributor mounts everything. The `@Controller` prefix is cosmetic
 * — real paths are computed from the resolved config.
 */
@Controller(STUDIO_DEFAULT_PATH)
export class StudioAdminController {}

// Class-level claim metadata the contributor matches on.
defineMetadata(STUDIO_ADMIN_META, { id: '@velajs/studio' }, StudioAdminController);

/** The one Studio contributor. `id` is stable so HMR re-registration overwrites. */
export const studioRouteContributor: RouteContributor = {
  id: '@velajs/studio',
  claimsMetaKey: STUDIO_ADMIN_META,
  buildRoutes(app, ctx) {
    // Capture the live Hono app + global prefix for the introspection ops — the
    // only public seam to the route table (RouteManager is barrel-internal).
    if (ctx.container.has(StudioAppHolder)) {
      ctx.container.resolve(StudioAppHolder).capture(app, ctx.routePathOptions);
    }
    mountAdminRouter(app, ctx);
  },
};

registerRouteContributor(studioRouteContributor);
