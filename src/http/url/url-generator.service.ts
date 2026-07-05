import { Injectable, Inject, Optional } from '../../container/decorators';
import { CONFIG_ENV } from '../../config/config.tokens';
import { signUrl } from '../../crypto/signed-url';
import { RouteManager } from '../route.manager';
import type { RouteDescription } from '../route.manager';
import type { RouteName, RouteParams } from '../route-map';
import { URL_SIGNING_SECRET, resolveSigningSecret } from './signing-secret';

/** Value accepted for a path param or query entry. */
type UrlParamValue = string | number | boolean;

/** Extra options for {@link UrlGeneratorService.urlFor}. */
export interface UrlForOptions {
  /** Additional query-string entries merged after any leftover params. */
  query?: Record<string, UrlParamValue>;
}

/** Options for {@link UrlGeneratorService.signedUrl}. */
export interface SignedUrlGenerateOptions {
  /** Time-to-live in seconds; enforced on verification via the `expires` param. */
  expiresIn?: number;
  /** Override the signing secret (else the `URL_SIGNING_SECRET` token / `CONFIG_ENV`). */
  secret?: string;
}

/**
 * Builds URLs for named routes (Laravel-flavoured `route()` ergonomics).
 *
 * Route descriptions are read LAZILY from the {@link RouteManager} on first use
 * — post-build, so composition (global prefix + version + controller prefix) is
 * already baked into each path — and it never instantiates controllers, so it
 * plays nicely with lazy modules. Registered as an app-level singleton by
 * `bootstrap`, so it is injectable anywhere.
 */
@Injectable()
export class UrlGeneratorService {
  private routeMap: Map<string, RouteDescription> | null = null;

  constructor(
    @Inject(RouteManager) private readonly routeManager: RouteManager,
    @Optional() @Inject(URL_SIGNING_SECRET) private readonly secretToken?: string,
    @Optional() @Inject(CONFIG_ENV) private readonly env: Record<string, unknown> = {},
  ) {}

  /**
   * Build the path for a named route, filling `:param` placeholders from
   * `params`. Params that don't match a placeholder become query-string
   * entries; `opts.query` is merged after them.
   *
   * @throws if no route carries `name`, or a required `:param` is missing.
   */
  urlFor<N extends RouteName>(name: N, params?: RouteParams<N>, opts?: UrlForOptions): string {
    const description = this.routes().get(name as string);
    if (!description) {
      throw new Error(
        `No route named "${String(name)}" was found. Give the route a name ` +
          `via \`@Get(path, { name: '${String(name)}' })\`.`,
      );
    }

    const provided = { ...(params ?? {}) } as Record<string, UrlParamValue | null | undefined>;
    const consumed = new Set<string>();

    const path = description.path.replace(/:([A-Za-z0-9_]+)/g, (_match, key: string) => {
      const value = provided[key];
      if (value === undefined || value === null) {
        throw new Error(`Missing route param "${key}" for route "${String(name)}".`);
      }
      consumed.add(key);
      return encodeURIComponent(String(value));
    });

    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(provided)) {
      if (consumed.has(key) || value === undefined || value === null) continue;
      query.set(key, String(value));
    }
    for (const [key, value] of Object.entries(opts?.query ?? {})) {
      if (value === undefined || value === null) continue;
      query.set(key, String(value));
    }

    const qs = query.toString();
    return qs ? `${path}?${qs}` : path;
  }

  /**
   * Build a named-route URL and HMAC-sign it (path + query). The secret comes
   * from `options.secret`, else the {@link URL_SIGNING_SECRET} token, else
   * `CONFIG_ENV`; a descriptive error is thrown when none is available.
   */
  async signedUrl<N extends RouteName>(
    name: N,
    params?: RouteParams<N>,
    options: SignedUrlGenerateOptions = {},
  ): Promise<string> {
    const url = this.urlFor(name, params);
    const secret = resolveSigningSecret(options.secret, this.secretToken, this.env);
    return signUrl(url, secret, options.expiresIn !== undefined ? { expiresIn: options.expiresIn } : undefined);
  }

  /**
   * Lazily index named route descriptions. Rebuilt while empty (routes may not
   * be built yet), cached once populated.
   */
  private routes(): Map<string, RouteDescription> {
    if (this.routeMap && this.routeMap.size > 0) return this.routeMap;
    const map = new Map<string, RouteDescription>();
    for (const description of this.routeManager.getRouteDescriptions()) {
      if (description.name && !map.has(description.name)) {
        map.set(description.name, description);
      }
    }
    this.routeMap = map;
    return map;
  }
}
