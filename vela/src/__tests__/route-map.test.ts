import { it, expect } from 'vitest';
import type { RouteName, RouteParams } from '../http/route-map';

// Type-level test for the zero-codegen route map. The assertions below are
// verified by `tsconfig.type-tests.json` (wired into `pnpm typecheck`), NOT by
// the main `tsc --noEmit` — the main project excludes `*.test.ts`, so this
// file's `VelaRouteMap` augmentation stays isolated and never leaks into the
// published package types. Consumers augment `'@velajs/vela'`; inside the repo
// we target the declaring module `'../http/route-map'`.
declare module '../http/route-map' {
  interface VelaRouteMap {
    'users.show': { id: string };
    'users.index': Record<string, never>;
  }
}

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// Augmentation narrows `RouteParams<'users.show'>` to the declared params.
type _ShowParams = Expect<Equal<RouteParams<'users.show'>, { id: string }>>;
type _IndexParams = Expect<Equal<RouteParams<'users.index'>, Record<string, never>>>;

// Augmentation narrows `RouteName` to the union of declared names — no longer
// the `string` fallback.
type _Names = Expect<Equal<RouteName, 'users.show' | 'users.index'>>;

// An undeclared name is rejected once the map is augmented.
type AssertRouteName<N extends RouteName> = N;
// @ts-expect-error — 'nope' is not a declared route name after augmentation
type _Rejected = AssertRouteName<'nope'>;

// Fallback formula (mirrors `RouteName`'s definition): an empty map collapses to
// `string`, which is the un-augmented default consumers get out of the box.
type FallbackRouteName<M> = keyof M extends never ? string : Extract<keyof M, string>;
type _Fallback = Expect<Equal<FallbackRouteName<Record<never, never>>, string>>;

// Keep every assertion referenced so it is retained by the compiler.
export type __RouteMapTypeAssertions = [_ShowParams, _IndexParams, _Names, _Rejected, _Fallback];

it('route-map types compile (assertions checked via tsconfig.type-tests.json)', () => {
  expect(true).toBe(true);
});
