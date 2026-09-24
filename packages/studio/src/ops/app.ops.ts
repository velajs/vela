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
import { Inject, Injectable } from '@velajs/vela';
import { Container } from '@velajs/vela/module-kit';
import { createOpenApiDocument } from '@velajs/vela/openapi';
import type { EntrypointRow, ModuleNode, RouteRow } from '@velajs/studio-protocol';
import { parseTryItRequest } from '@velajs/studio-protocol';
import { AdminRpc } from '../rpc/admin-rpc.decorator';
import { STUDIO_RESOLVED_CONFIG } from '../tokens';
import type { AdminOpContext, ResolvedStudioConfig } from '../studio.types';
import { studioError } from '../studio.errors';
import { StudioAppHolder } from '../introspect/app-holder';
import { collectEntrypoints, collectModules, collectRoutes } from '../introspect/collect';

/** Canonicalize paths for authorization; no request is dispatched against this origin. */
const TRYIT_ORIGIN = 'http://studio.tryit.internal';

/** Drop a single trailing slash so prefix comparisons are exact (`''` stays `''`). */
function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/** True iff `pathname` equals `prefix` or is nested under it (`prefix` + `/…`). */
function isUnder(pathname: string, prefix: string): boolean {
  const base = stripTrailingSlash(prefix);
  const target = stripTrailingSlash(pathname);
  return target === base || target.startsWith(`${base}/`);
}

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
   * The OpenAPI document for the configured `rootModule`, or else the
   * application's own root (`ROOT_MODULE`). Without either (a container built
   * outside `bootstrap`), the op reports `FEATURE_UNCONFIGURED`, the same code
   * `studio.capabilities` uses to keep the `openapi` feature dark.
   */
  @AdminRpc({ op: 'app.openapi' })
  openapi(_ctx: AdminOpContext): unknown {
    const root = this.config.rootModule;
    if (root === undefined) throw studioError('FEATURE_UNCONFIGURED');
    // Carry the app's captured route composition so documented paths match the
    // real mounted routes (the contributor deposits it in the holder at mount time).
    return createOpenApiDocument(root, this.holder.routePathOptions);
  }

  /** Authorize the host's HTTP request without re-entering Hono outside Worker context. */
  @AdminRpc({ op: 'api.authorizeTryIt' })
  authorizeTryIt(ctx: AdminOpContext, input: unknown): { authorized: true } {
    let args: ReturnType<typeof parseTryItRequest>;
    try {
      args = parseTryItRequest(input);
    } catch {
      throw studioError('STUDIO_OP_FORBIDDEN', 'Invalid API request');
    }
    const url = new URL(args.path, TRYIT_ORIGIN);
    let pathname: string;
    try {
      pathname = new URL(decodeURIComponent(url.pathname), TRYIT_ORIGIN).pathname;
    } catch {
      throw studioError('STUDIO_OP_FORBIDDEN', 'Invalid API path');
    }
    this.assertNotAdminSurface(pathname);
    ctx.audit({
      target: `${args.method} ${url.pathname}`,
      summary: 'Authorized host HTTP request',
    });
    return { authorized: true };
  }

  /**
   * Throw `STUDIO_OP_FORBIDDEN` when `pathname` targets Studio's own reserved
   * admin surface. The surface mounts at `base` (= the app's global prefix + the
   * reserved path, or the path verbatim when `absolute`); we also block the bare
   * reserved path so a request that omits (or spoofs) the prefix cannot slip
   * through. See {@link tryit}'s security note.
   */
  private assertNotAdminSurface(pathname: string): void {
    const path = this.config.path;
    const prefix = stripTrailingSlash(this.holder.globalPrefix);
    const base = this.config.absolute || prefix === '' ? path : `${prefix}${path}`;
    if (isUnder(pathname, base) || isUnder(pathname, path)) {
      throw studioError(
        'STUDIO_OP_FORBIDDEN',
        'API requests may not target the reserved Studio admin surface',
      );
    }
  }
}
