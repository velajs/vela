// Middleware route targets and the route patterns they are checked against
// compile to anchored regular expressions owned by Vela, not to a Hono router:
// a Nest wildcard then matches with ordinary backtracking wherever it sits,
// including before a parameter or a literal segment.

/** One segment of a route pattern, as parsed by {@link parseRoutePattern}. */
export interface RouteSegment {
  /** The segment in Hono syntax, with Nest wildcards as `:name{.+}`, for messages. */
  readonly text: string;
  /** Its regular-expression source, leading `/` included. */
  readonly source: string;
  /** Text matched as written: a literal segment, or the start of a trailing `ab*`. */
  readonly fixed?: string;
  /** The values a `:name{regex}` parameter accepts. */
  readonly constraint?: RegExp;
  /** A trailing `:name?`, `*` or `{*name}` may be absent. */
  readonly optional?: boolean;
  /** The segment already matches every path beneath it. */
  readonly open?: boolean;
}

const NEST_NAMED_WILDCARD = /^\*([\p{ID_Start}$_][\p{ID_Continue}$]*)$/u;
const NEST_OPTIONAL_WILDCARD = /^\{\*[\p{ID_Start}$_][\p{ID_Continue}$]*\}$/u;
// `:name`, `:name{regex}`, either with a trailing `?`.
const PARAM = /^:([^{}()*?:]+)(?:\{(.+)\})?(\?)?$/s;
// Literal text, optionally ending in Hono's prefix wildcard (`ab*`).
const LITERAL = /^([^{}()*?:][^{}()*?]*)(\*)?$/;
const ANY_SEGMENT = '/[^/]+';
const REST = '(?:/.*)?';
// Values tried for a parameter when looking for a path two patterns share.
const SAMPLE_VALUES = ['1', 'x'];

// A non-empty segment: '/' may appear only inside a parameter's `{regex}`,
// which may nest one level of braces (`:id{[0-9]{3}}`).
const SEGMENT = /(?:[^/{}]|\{(?:[^{}]|\{[^{}]*\})*\})+/g;

/**
 * Parses a route pattern: Hono's `:name`, `:name{regex}`, a trailing `:name?`,
 * `*` (one segment, or the parent and the rest of the path when trailing) and
 * a trailing `ab*`, plus Nest's `*name` and `(.*)` (one or more characters
 * across segments) and a trailing `{*name}` (the parent and the rest of the
 * path). Returns `undefined` for any other syntax.
 */
export function parseRoutePattern(path: string): RouteSegment[] | undefined {
  // Braces the segments did not consume are unbalanced.
  if (/[^/]/.test(path.replace(SEGMENT, ''))) return undefined;
  const parts = path.match(SEGMENT) ?? [];
  const segments: RouteSegment[] = [];
  let unnamed = 0;
  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1;
    const wildcard = NEST_NAMED_WILDCARD.exec(part);
    const param = PARAM.exec(part);
    const literal = LITERAL.exec(part);
    if (wildcard || part === '(.*)') {
      const name = wildcard?.[1] ?? `wildcard${unnamed++}`;
      segments.push({ text: `:${name}{.+}`, source: '/.+', open: true });
    } else if (part === '*' || (last && NEST_OPTIONAL_WILDCARD.test(part))) {
      segments.push(
        last
          ? { text: '*', source: REST, optional: true, open: true }
          : { text: '*', source: ANY_SEGMENT },
      );
    } else if (param) {
      const [, , regex, optional] = param;
      if (optional && !last) return undefined;
      let constraint: RegExp | undefined;
      try {
        if (regex !== undefined) constraint = new RegExp(`^(?:${regex})$`);
      } catch {
        return undefined;
      }
      const value = regex === undefined ? ANY_SEGMENT : `/(?:${regex})`;
      segments.push({
        text: part,
        source: optional ? `(?:${value})?` : value,
        constraint,
        optional: !!optional,
      });
    } else if (literal && (last || !literal[2])) {
      const fixed = literal[1]!;
      const escaped = `/${fixed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
      segments.push(
        literal[2]
          ? { text: part, source: `${escaped}.*`, fixed, open: true }
          : { text: part, source: escaped, fixed },
      );
    } else return undefined;
  }
  return segments;
}

/** A pattern written back in Hono syntax, for messages. */
export function formatRoutePattern(segments: readonly RouteSegment[]): string {
  return `/${segments.map((segment) => segment.text).join('/')}`;
}

/**
 * The anchored regular expression for a parsed pattern. With `descendants`
 * it also matches every path beneath it, as a `forRoutes()` target does.
 */
export function compileRoutePattern(
  segments: readonly RouteSegment[],
  descendants: boolean,
): RegExp {
  let source = segments.map((segment) => segment.source).join('');
  if (descendants && !segments.at(-1)?.open) source += REST;
  return new RegExp(`^${source || '/'}$`);
}

// Concrete paths shaped like `segments`, one per variant. Variant 0 fills a
// parameter from the other pattern's literal at the same position (`hints`)
// when it fits; variant n tries sample n first and leaves optional segments out
// when n is 1.
function samplePaths(segments: readonly RouteSegment[], hints: readonly RouteSegment[]): string[] {
  return [0, 1, 2].map((variant) => {
    let path = '';
    for (const [index, segment] of segments.entries()) {
      if (segment.fixed !== undefined) {
        path += `/${segment.fixed}`;
        continue;
      }
      if (segment.optional && variant === 1) continue;
      const hint = hints[index]?.fixed;
      const value = [variant ? SAMPLE_VALUES[variant - 1] : hint, hint, ...SAMPLE_VALUES].find(
        (candidate) =>
          candidate !== undefined && (!segment.constraint || segment.constraint.test(candidate)),
      );
      path += `/${value ?? SAMPLE_VALUES[0]}`;
    }
    return path || '/';
  });
}

/**
 * Whether some concrete path matches both patterns. Candidate paths are built
 * from each pattern's shape and must match both regular expressions, so an
 * overlap is only reported for a path that exists; two patterns that share a
 * path only through values these samples miss count as disjoint.
 */
export function routePatternsOverlap(
  a: readonly RouteSegment[],
  aRegex: RegExp,
  b: readonly RouteSegment[],
  bRegex: RegExp,
): boolean {
  return [...samplePaths(a, b), ...samplePaths(b, a)].some(
    (path) => aRegex.test(path) && bRegex.test(path),
  );
}
