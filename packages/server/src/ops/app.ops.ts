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
import type {
  EntrypointRow,
  ModuleNode,
  RouteRow,
  TryItRequest,
  TryItResponse,
} from '@velajs/studio-protocol';
import { AdminRpc } from '../rpc/admin-rpc.decorator';
import { STUDIO_RESOLVED_CONFIG } from '../tokens';
import type { AdminOpContext, ResolvedStudioConfig } from '../studio.types';
import { studioError } from '../studio.errors';
import { StudioAppHolder } from '../introspect/app-holder';
import { collectEntrypoints, collectModules, collectRoutes } from '../introspect/collect';

/**
 * Synthetic origin for the `api.tryit` sub-request URL. Only its pathname/search
 * reaches Hono's router (the origin is discarded), but a valid absolute URL is
 * required to resolve a caller-supplied relative `path` and to canonicalize any
 * `..`/`.` segments before the reserved-surface guard inspects it.
 */
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

/**
 * Read a captured sub-response body: JSON when the response says so (falling back
 * to raw text on a parse error), plain text otherwise, and `null` for an empty
 * body. Mirrors what the UI's `JsonBlock` renders.
 */
async function readTryItBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return null;
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json') || contentType.includes('+json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
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
    // Carry the app's captured global prefix so documented paths match the real
    // mounted routes (the contributor deposits it in the holder at mount time).
    return createOpenApiDocument(root, { globalPrefix: this.holder.globalPrefix });
  }

  /**
   * `api.tryit` — dispatch an arbitrary request THROUGH the app's own captured
   * Hono instance and return the real status/headers/body it produced. This is
   * the API explorer's "try it": it exercises the app's actual composed routes
   * (with all their middleware), not a mock.
   *
   * Gating is applied by the dispatch registry AROUND this handler: the op is
   * `mode: 'write', gate: 'opsEditable'`, so a read-only Studio (opsEditable off)
   * gets a 403 before we run, and every call is audited. It is admin-token-gated
   * too (the whole RPC surface is behind the master bearer).
   *
   * SECURITY — recursive-admin guard: because this proxies ANY verb at ANY path,
   * a caller could otherwise aim it at Studio's OWN reserved admin surface
   * (`/rpc/:op`, `/export`, `/ws-token`, `/health`) and drive the admin API
   * through itself — a confused-deputy path that could, e.g., re-enter a
   * different op whose own gate we do NOT want reached this way. We refuse: any
   * `path` resolving under the reserved admin base (or the bare reserved path, as
   * defense-in-depth against a missing/foreign global prefix) is rejected with
   * `STUDIO_OP_FORBIDDEN` (403) BEFORE the sub-request is made. `api.tryit` is a
   * tool for the app's routes only; the admin surface is off-limits to it.
   */
  @AdminRpc({ op: 'api.tryit' })
  async tryit(ctx: AdminOpContext, args: TryItRequest): Promise<TryItResponse> {
    const app = this.holder.app;
    if (app === null) {
      throw studioError('FEATURE_UNCONFIGURED', 'the app route table has not been captured yet');
    }

    const method = (args.method ?? 'GET').toUpperCase();
    const url = new URL(args.path && args.path !== '' ? args.path : '/', TRYIT_ORIGIN);
    if (args.query !== undefined) {
      for (const [key, value] of Object.entries(args.query)) url.searchParams.set(key, value);
    }

    // Refuse to proxy the reserved admin surface (recursive-admin guard).
    this.assertNotAdminSurface(url.pathname);

    const headers = new Headers(args.headers ?? {});
    const init: RequestInit = { method, headers };
    // A body is only meaningful (and legal for `fetch`) on non-GET/HEAD verbs.
    if (method !== 'GET' && method !== 'HEAD' && args.body !== undefined) {
      init.body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }

    const res = await app.request(url.toString(), init);
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      outHeaders[key] = value;
    });
    const body = await readTryItBody(res);

    ctx.audit({
      target: `${method} ${url.pathname}`,
      summary: `try-it ${method} ${url.pathname} → ${res.status}`,
    });
    return { status: res.status, headers: outHeaders, body };
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
        'api.tryit may not target the reserved Studio admin surface',
      );
    }
  }
}
