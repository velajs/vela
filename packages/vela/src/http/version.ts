/**
 * A route or controller version served without a version segment, as Nest's
 * `VERSION_NEUTRAL`. Combine it with numbers to serve both.
 */
export const VERSION_NEUTRAL: unique symbol = Symbol.for('vela.version-neutral');

/** One URI version of a route: a number, or {@link VERSION_NEUTRAL}. */
export type RouteVersion = number | typeof VERSION_NEUTRAL;

/** `@Controller({ version })` and `@Version()` values. */
export type VersionValue = RouteVersion | readonly RouteVersion[];
