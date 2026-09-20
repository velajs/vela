// Zero-codegen, type-safe route names — mirrors the augmentation pattern from
// stratal `packages/core/src/router/route-map.ts` (MIT © Temitayo Fadojutimi).
// Adapted for vela: `VelaRouteMap` maps a route name directly to its params
// object (stratal wraps params in `{ params: … }`; vela keeps it flat to match
// the `urlFor(name, params)` call shape).

/**
 * Augmentable map of route name → its path params. Users opt in to type-safe
 * URL generation by augmenting this interface — no build step, no codegen:
 *
 * ```ts
 * declare module '@velajs/vela' {
 *   interface VelaRouteMap {
 *     'users.index': Record<string, never>;
 *     'users.show': { id: string };
 *   }
 * }
 * ```
 *
 * Until augmented it stays empty, so `RouteName` falls back to `string` and
 * `RouteParams<N>` to a loose `Record<string, string> | undefined` — untyped
 * callers keep working unchanged.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- augmentable interface, intentionally empty until a consumer declares routes
export interface VelaRouteMap {}

/**
 * Every valid route name. Falls back to `string` when `VelaRouteMap` has not
 * been augmented, so `urlFor`/`signedUrl` accept any name in an untyped app.
 */
export type RouteName = keyof VelaRouteMap extends never
  ? string
  : Extract<keyof VelaRouteMap, string>;

/**
 * The params object required to build a named route's URL. When `VelaRouteMap`
 * is augmented, resolves to the declared params shape for `N`; otherwise a
 * loose `Record<string, string> | undefined`.
 */
export type RouteParams<N extends RouteName> = N extends keyof VelaRouteMap
  ? VelaRouteMap[N]
  : Record<string, string> | undefined;
