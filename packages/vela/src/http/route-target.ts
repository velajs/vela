// Middleware route targets are Hono route patterns. Vela registers each one on
// the application's Hono app as a route that does nothing, so Hono's own router
// decides which requests a target matches, exactly as it decides which route
// serves them. Vela only translates Nest's wildcards and rejects the syntax
// Hono would read differently from Nest.

import { splitRoutingPath } from 'hono/utils/url';

// A trailing Nest wildcard: `{*name}`, `*name` or `(.*)`.
const NEST_WILDCARD =
  /^(?:\{\*[\p{ID_Start}$_][\p{ID_Continue}$]*\}|\*([\p{ID_Start}$_][\p{ID_Continue}$]*)|\(\.\*\))$/u;
// One part Hono matches as written: `*`, `:name` or `:name{regex}`, optionally
// ending in `?`, or literal text, optionally ending in Hono's prefix `*`. Only
// the last part may end in `?` or a prefix `*`.
const HONO_PART = /^(?:\*|:[^{}()*?:]+(?:\{(.+)\})?(\?)?|[^{}()*?]*(\*)?)$/s;

// Hono compiles a constraint only when it first routes a request, and its
// default router fails on a parameter that captures nothing.
function isConstraint(source?: string): boolean {
  try {
    return source === undefined || !RegExp(`^(?:${source})$`).test('');
  } catch {
    return false;
  }
}

/**
 * A middleware target in Hono syntax, with a leading `/`. A trailing Nest
 * `{*name}` becomes Hono's `*`, and a trailing `*name` or `(.*)`, which match
 * one or more characters across segments, becomes `:name{[\s\S]+}`. Throws for
 * any other group, optional-segment or wildcard syntax, including a Nest
 * wildcard before the last segment, which no Hono pattern expresses, and for a
 * constraint that is not a regular expression or matches an empty segment.
 */
export function toHonoPattern(path: string): string {
  const parts = splitRoutingPath(path);
  return `/${parts
    .map((part, index) => {
      const last = index === parts.length - 1;
      const nest = last && NEST_WILDCARD.exec(part);
      if (nest) return part[0] === '{' ? '*' : `:${nest[1] ?? 'path'}{[\\s\\S]+}`;
      const hono = HONO_PART.exec(part);
      if (hono && (last || !(hono[2] || hono[3])) && isConstraint(hono[1])) return part;
      throw new Error(
        `Middleware route '${path}' uses pattern syntax that Hono does not match, so its ` +
          "middleware would never run. Use ':id', ':id{[0-9]+}', or a trailing '*' or '*path'.",
      );
    })
    .join('/')}`;
}

/**
 * The patterns a `forRoutes()` target is registered as. Beneath `/cats`,
 * `/cats/`, `/cats/:id?` or `/cats/*` means `/cats` and every path under it:
 * - the pattern itself, since Hono can serve a route on a path that only the
 *   pattern matches (a constraint such as `{\d+|me}` matches part of a segment);
 * - Hono's trailing `*` form;
 * - a parameter form, `/cats/:_{[^]+}`. Hono's default RegExpRouter applies a
 *   path ending in `*` to the routes whose pattern text it matches, and misses
 *   one that has a parameter where the path has `*`, or the reverse. It cannot
 *   hold this form beside a deeper route, so it falls back to its TrieRouter,
 *   which matches every pattern against the request path. The form needs a
 *   character because that router fails on a parameter that captures nothing.
 * A `'*'` target and Hono's prefix wildcard (`/admin/us*`) cover the paths
 * beneath them as written.
 */
export function withDescendants(pattern: string): string[] {
  if (pattern === '/*' || /[^/]\*$/.test(pattern)) return [pattern];
  const parent = pattern.replace(/\/(?::[^/]+\?|\*)?$/, '');
  return [...new Set([pattern, `${parent}/*`, `${parent}/:_{[^]+}`])];
}

/**
 * Request paths shaped like a Hono pattern, for the startup check of targets
 * against routes. Each parameter and `*` takes the literal `other` has at the
 * same position, then `1`, then `x`; the last variant also leaves out a
 * trailing optional part or `*`.
 */
export function samplePaths(pattern: string, other: string): string[] {
  const parts = splitRoutingPath(pattern);
  const hints = splitRoutingPath(other);
  return [0, 1, 2, 3].map(
    (variant) =>
      `/${parts
        .flatMap((part, index) => {
          if (!/^[:*]/.test(part)) return part.replace(/\*$/, '');
          if (variant === 3 && index === parts.length - 1 && /^\*$|\?$/.test(part)) return [];
          const hint = variant ? undefined : hints[index];
          return variant === 2 ? 'x' : hint && !/^[:*]|\*$/.test(hint) ? hint : '1';
        })
        .join('/')}`,
  );
}
