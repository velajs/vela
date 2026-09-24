import { HttpMethod } from '../constants';
import type { RouteInfo } from '../module/middleware';
import { joinPaths } from '../registry/paths';
import { matchTarget, parseTarget, type RouteTarget } from './route-target';
import { VERSION_NEUTRAL, type RouteVersion, type VersionValue } from './version';

export { VERSION_NEUTRAL, type RouteVersion, type VersionValue } from './version';

/** Options for the global prefix, as Nest's `setGlobalPrefix(prefix, options)`. */
export interface GlobalPrefixOptions {
  /**
   * Routes served without the global prefix. Each target uses the middleware
   * route grammar and is matched against the controller path plus the route
   * path; a `method` limits it to that method. Relative middleware targets
   * (`forRoutes('admin/*')`) resolve under the prefix, so they do not match an
   * excluded route: startup fails until an absolute target
   * (`{ path: '/admin/report', absolute: true }`) or the controller covers it,
   * or an absolute `exclude()` leaves it out.
   */
  exclude?: Array<string | RouteInfo>;
}

/** URI versioning options. */
export interface VersioningOptions {
  /**
   * The segment text before a version number: `'v'` (default) serves
   * `/v1/...`, `false` serves `/1/...`.
   */
  prefix?: string | false;
}

/** How controller routes compose into served paths. */
export interface RoutePathOptions {
  globalPrefix?: string;
  globalPrefixOptions?: GlobalPrefixOptions;
  versioning?: VersioningOptions;
}

interface Exclusion {
  readonly method: string;
  readonly target: RouteTarget;
}

/** A composed route path and the version it serves (`undefined` when unversioned or neutral). */
export interface ComposedRoutePath {
  path: string;
  version?: number;
}

export function normalizeGlobalPrefix(prefix: string): string {
  return prefix && !prefix.startsWith('/') ? `/${prefix}` : prefix;
}

/** Validates the options once and returns the composer every route uses. */
export function createRouteComposer(
  options: RoutePathOptions,
): (
  controllerPrefix: string,
  route: { path: string; method: string; version?: VersionValue },
  controllerVersion?: VersionValue,
) => ComposedRoutePath[] {
  const globalPrefix = normalizeGlobalPrefix(options.globalPrefix ?? '');
  const exclusions: Exclusion[] = (options.globalPrefixOptions?.exclude ?? []).map((entry) => {
    const info = typeof entry === 'string' ? { path: entry } : entry;
    try {
      return { method: info.method ?? HttpMethod.ALL, target: parseTarget(info.path) };
    } catch (error) {
      throw new Error(
        String(error instanceof Error ? error.message : error).replace(
          /^Middleware route/,
          'Global prefix exclusion',
        ),
        { cause: error },
      );
    }
  });
  const versionPrefix = options.versioning?.prefix ?? 'v';
  if (versionPrefix !== false && !/^[A-Za-z0-9._~-]*$/.test(versionPrefix)) {
    throw new Error(
      `Invalid version prefix '${versionPrefix}': use unreserved URL characters without '/'`,
    );
  }

  return (controllerPrefix, route, controllerVersion) => {
    const localPath = joinPaths(controllerPrefix, route.path);
    const segments = localPath.replace(/^\//, '').split('/');
    const excluded = exclusions.some(
      ({ method, target }) =>
        (method === HttpMethod.ALL || method === route.method) && matchTarget(target, segments),
    );
    const prefix = excluded ? '' : globalPrefix;
    const version = route.version ?? controllerVersion;
    if (version === undefined) return [{ path: joinPaths(prefix, localPath) }];
    const versions = (Array.isArray(version) ? version : [version]) as readonly RouteVersion[];
    return versions.map((entry) =>
      entry === VERSION_NEUTRAL
        ? { path: joinPaths(prefix, localPath) }
        : {
            path: joinPaths(prefix, joinPaths(`/${versionPrefix || ''}${entry}`, localPath)),
            version: entry,
          },
    );
  };
}
