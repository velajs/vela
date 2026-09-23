// Middleware path targets use a small grammar that Vela matches itself,
// segment by segment, in time linear in the request path: literal segments,
// `:name` segments and a trailing wildcard. Hono's routers still read some of
// these differently: its RegExpRouter's trailing `*` stops at a decoded line
// terminator, its LinearRouter serves `:name` on an empty segment and its
// PatternRouter reads `:name.pdf` as `:name` followed by `.pdf`. forRoutes()
// takes the broader reading, so no router serves a route without its
// middleware: `:name` also matches an empty segment. exclude() takes the
// strict one: `:name` matches one non-empty segment, so an empty segment never
// skips the middleware. A trailing wildcard covers decoded line terminators in
// both, as the routes beneath it serve them. A `:name` must be an identifier,
// and any other syntax fails the route build.

import { splitRoutingPath } from 'hono/utils/url';

/** A parsed middleware path target. */
export interface RouteTarget {
  /** Literal segments as written, and `:name` for a parameter segment. */
  readonly parts: readonly string[];
  /**
   * How the target ends: `''` exactly at its parts, `'*'` at its parts and
   * every path beneath them, `'+'` at one or more characters beneath them.
   */
  readonly tail: '' | '*' | '+';
}

// A trailing wildcard: `*` or Nest's `{*name}`, then Nest's `*name` or `(.*)`.
const WILDCARD =
  /^(?:(\*|\{\*[\p{ID_Start}$_][\p{ID_Continue}$]*\})|\*[\p{ID_Start}$_][\p{ID_Continue}$]*|\(\.\*\))$/u;

/**
 * Parses a target: literal segments, matched exactly, and `:name` segments
 * whose name is an identifier. The last segment may instead be `*` or
 * `{*name}` (the parent path and every path beneath it) or `*name` or `(.*)`
 * (one or more characters beneath the parent; `forRoutes()` widens a trailing
 * `(.*)` to its parent, as Nest 11 reads it). A trailing `/` is a segment of
 * its own. Throws, naming the cause, for a `{regex}` constraint, an optional
 * `?`, a wildcard before the last segment, a parameter name that is not an
 * identifier, a `*` or `:` inside a segment, any other parentheses or braces,
 * and an empty segment.
 */
export function parseTarget(path: string): RouteTarget {
  const parts = path.replace(/^\//, '').split('/');
  const last = parts.length - 1;
  let tail: RouteTarget['tail'] = '';
  for (const [index, part] of parts.entries()) {
    const wildcard = WILDCARD.exec(part);
    if (wildcard) tail = wildcard[1] ? '*' : '+';
    // Hono's routers disagree on where a parameter name such as 'name.pdf'
    // ends, so a ':name' segment must be ':' and an identifier.
    const cause = path.includes('?')
      ? "uses an optional '?': list each path or target the controller"
      : wildcard
        ? index < last && 'has a wildcard before its last segment'
        : /^:.*\{/s.test(part)
          ? "uses a '{regex}' constraint: use ':name' or target the controller"
          : /[(){}]/.test(part)
            ? "uses a group: only a trailing '{*name}' or '(.*)' may use braces or parentheses"
            : !/^(?::[\p{ID_Start}$_][\p{ID_Continue}$]*|[^*:]*)$/u.test(part)
              ? "puts '*' or ':' inside a segment, or names a parameter that is not an " +
                "identifier: use a whole ':name' segment, list the paths, or target the controller"
              : !part && index < last && 'has an empty segment';
    if (cause) throw new Error(`Middleware route '${path}' ${cause}.`);
  }
  // '' and '/' are the root.
  return { parts: tail || last || parts[0] ? parts.slice(0, tail ? -1 : undefined) : [], tail };
}

/**
 * Whether a target matches a path, given as its segments beneath the root.
 * `:name` matches one non-empty segment, or any segment when `loose`.
 */
export function matchTarget(
  { parts, tail }: RouteTarget,
  segments: readonly string[],
  loose?: boolean,
): boolean {
  const extra = segments.length - parts.length;
  return (
    (tail === '*' ? extra >= 0 : tail ? extra > 1 || (extra === 1 && !!segments.at(-1)) : !extra) &&
    parts.every((part, index) =>
      part[0] === ':' ? loose || segments[index] : part === segments[index],
    )
  );
}

/**
 * The segments of `path` from `index` on, beneath a base that ends in `/`:
 * none for the base itself, and `undefined` when the path stops before it.
 */
export function segmentsBeneath(path: readonly string[], index: number): string[] | undefined {
  const rest = path.slice(index);
  return rest.length > 1 || rest[0] ? rest : rest.length ? [] : undefined;
}

// Strings with a '/', to probe a base parameter's '{regex}' with.
const SLASHED = ['/', 'a/', '/a', 'a/a', '0/0'];

/**
 * The request path's segments beneath `base`, the route pattern a parent app
 * mounted this one under with `parent.route(base, app)`, reading its
 * parameters from `param`. `undefined` when the base does not spell the start
 * of the path, segment for segment, as when Hono decoded a parameter value,
 * and when a base parameter's `{regex}` constraint matches a string with a
 * `/`: Hono can then give the running middleware and the route it runs for
 * different values, such as `acme/admin` and `acme` under `/:org{.+}`.
 */
export function segmentsUnder(
  path: string,
  base: string,
  param: (name: string) => string | undefined,
): string[] | undefined {
  const segments = path.split('/');
  let index = 1;
  for (const part of splitRoutingPath(base)) {
    if (!part) continue;
    const [, name, constraint] = /^:([^{}]+)(?:\{(.*)\})?$/s.exec(part) ?? [];
    const value = name ? param(name) : part;
    if (
      value === undefined ||
      segments[index++] !== value ||
      (constraint && SLASHED.some((sample) => new RegExp(`^(?:${constraint})$`).test(sample)))
    ) {
      return undefined;
    }
  }
  // A base that ends in '/' puts the app's root at the base itself.
  return base.endsWith('/') ? segmentsBeneath(segments, index) : segments.slice(index);
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
