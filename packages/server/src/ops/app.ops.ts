/**
 * Application-introspection ops: `app.routes`, `app.modules`, `app.entrypoints`,
 * `app.openapi`. Each is a discoverable `@AdminRpc` handler; the dispatch
 * registry resolves this provider per call (lazy-safe) and invokes the method
 * with `(ctx, args)`.
 *
 * Data reaches these handlers through the seams the M4 investigation settled on
 * (see `introspect/collect.ts`): the captured Hono app for routes, the public
 * `Container` for modules, the public `EntrypointRegistry` for entrypoints, and
 * the barrel `createOpenApiDocument` for the spec.
 */
import { Container, Inject, Injectable, createOpenApiDocument } from '@velajs/vela';
import type { EntrypointRow, ModuleNode, RouteRow } from '@velajs/studio-protocol';
import { AdminRpc } from '../rpc/admin-rpc.decorator';
import { STUDIO_RESOLVED_CONFIG } from '../tokens';
import type { AdminOpContext, ResolvedStudioConfig } from '../studio.types';
import { studioError } from '../studio.errors';
import { StudioAppHolder } from '../introspect/app-holder';
import { collectEntrypoints, collectModules, collectRoutes } from '../introspect/collect';

@Injectable()
export class StudioAppOps {
  constructor(
    @Inject(Container) private readonly container: Container,
    @Inject(StudioAppHolder) private readonly holder: StudioAppHolder,
    @Inject(STUDIO_RESOLVED_CONFIG) private readonly config: ResolvedStudioConfig,
  ) {}

  @AdminRpc({ op: 'app.routes' })
  routes(_ctx: AdminOpContext): RouteRow[] {
    return collectRoutes(this.holder);
  }

  @AdminRpc({ op: 'app.modules' })
  modules(_ctx: AdminOpContext): ModuleNode[] {
    return collectModules(this.container);
  }

  @AdminRpc({ op: 'app.entrypoints' })
  entrypoints(_ctx: AdminOpContext): EntrypointRow[] {
    return collectEntrypoints(this.container);
  }

  /**
   * The OpenAPI document for the configured root module. `app.openapi` is only
   * meaningful when the operator hands Studio the app's root module (Studio is
   * mounted as an imported module and cannot discover it otherwise), so an
   * absent `rootModule` is a configuration gap, reported as `FEATURE_UNCONFIGURED`
   * — the same code `studio.capabilities` uses to keep the `openapi` feature dark.
   */
  @AdminRpc({ op: 'app.openapi' })
  openapi(_ctx: AdminOpContext): unknown {
    const root = this.config.rootModule;
    if (root === undefined) throw studioError('FEATURE_UNCONFIGURED');
    return createOpenApiDocument(root);
  }
}
