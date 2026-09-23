// Middleware path targets use a small grammar that Vela matches itself,
// segment by segment, in time linear in the request path: literal segments,
// `:name` segments and a trailing wildcard. Hono's routers agree on what each
// of these means, so a target matches the requests a route with the same
// pattern would serve. Any other syntax fails the route build.

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
 * Parses a target: literal segments, matched exactly, and `:name` segments,
 * which match one non-empty segment. The last segment may instead be `*` or
 * `{*name}` (the parent path and every path beneath it) or `*name` or `(.*)`
 * (one or more characters beneath the parent). A trailing `/` is a segment of
 * its own. Throws, naming the cause, for a `{regex}` constraint, an optional
 * `?`, a wildcard before the last segment, a `*` or `:` inside a segment, any
 * other parentheses or braces, and an empty segment.
 */
export function parseTarget(path: string): RouteTarget {
  const parts = path.replace(/^\//, '').split('/');
  const last = parts.length - 1;
  let tail: RouteTarget['tail'] = '';
  const reject = (cause: string): never => {
    throw new Error(`Middleware route '${path}' ${cause}.`);
  };
  if (path.includes('?')) {
    reject(
      "uses an optional '?': optional segments are not supported in middleware targets; " +
        'list each path or target the controller',
    );
  }
  for (const [index, part] of parts.entries()) {
    const wildcard = WILDCARD.exec(part);
    if (wildcard) {
      if (index < last) reject('has a wildcard before its last segment');
      tail = wildcard[1] ? '*' : '+';
    } else if (/^:.*\{/s.test(part)) {
      reject(
        "uses a '{regex}' constraint: constraints are not supported in middleware targets; " +
          "use ':name' or target the controller",
      );
    } else if (/[(){}]/.test(part)) {
      reject("uses a group: only a trailing '{*name}' or '(.*)' may use braces or parentheses");
    } else if (/\*|.:|^:$/s.test(part)) {
      reject("puts '*' or ':' inside a segment: write a whole ':name' segment");
    } else if (!part && index < last) {
      reject('has an empty segment');
    }
  }
  // '' and '/' are the root.
  return { parts: tail || last || parts[0] ? parts.slice(0, tail ? -1 : undefined) : [], tail };
}

/**
 * The target a `forRoutes()` target covers: its path and every path beneath
 * it. A trailing `/` covers the same paths as its parent.
 */
export function withDescendants({ parts, tail }: RouteTarget): RouteTarget {
  return tail
    ? { parts, tail }
    : { parts: parts.at(-1) === '' ? parts.slice(0, -1) : parts, tail: '*' };
}

/** Whether a target matches a path, given as its segments beneath the root. */
export function matchTarget({ parts, tail }: RouteTarget, segments: readonly string[]): boolean {
  const extra = segments.length - parts.length;
  return (
    (tail === '*' ? extra >= 0 : tail ? extra > 1 || (extra === 1 && !!segments.at(-1)) : !extra) &&
    parts.every((part, index) => (part[0] === ':' ? segments[index] : part === segments[index]))
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

/**
 * The request path's segments beneath `base`, the route pattern a parent app
 * mounted this one under with `parent.route(base, app)`, reading its
 * parameters from `param`. `undefined` when the base does not spell the start
 * of the path, segment for segment, as when Hono decoded a parameter value.
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
    const name = /^:([^{}]+)(?:\{.*\})?$/s.exec(part)?.[1];
    const value = name === undefined ? part : param(name);
    if (value === undefined) return undefined;
    for (const segment of value.split('/')) if (segments[index++] !== segment) return undefined;
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
