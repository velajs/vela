# @velajs/feature-flags

Edge-first, driver-based feature flags for the [Vela](https://github.com/velajs/vela) framework.

Runs on Cloudflare Workers, Deno, Bun, Node 20+, and Vercel Edge — the package source is
edge-pure (no `node:*`, `Buffer`, or `process`). Backends plug in through one small
`FeatureFlagDriver` contract; an in-memory driver ships in the box and doubles as the test fake.

## Install

```sh
pnpm add @velajs/feature-flags
```

## Quick start

```ts
import { FeatureFlagsModule, FeatureFlagsService, memoryFlagDriver } from '@velajs/feature-flags';

@Module({
  imports: [
    FeatureFlagsModule.forRoot({
      drivers: [memoryFlagDriver({ values: { 'new-checkout': false } })],
      manifest: { 'new-checkout': false, layout: 'v1' },
      context: (ctx) => ({ userId: ctx.get('userId') }), // merged into every evaluation
    }),
  ],
})
class AppModule {}

// Inject and evaluate — evaluation never throws.
class CheckoutService {
  constructor(@Inject(FEATURE_FLAG_TOKENS.Service) private readonly flags: FeatureFlagsService) {}

  async run() {
    if (await this.flags.getBooleanValue('new-checkout')) { /* … */ }
    const layout = await this.flags.getStringValue('layout'); // manifest default when unset
  }
}
```

`forRootAsync({ inject, useFactory })` is also generated for you.

## Hiding routes behind a flag

```ts
import { FeatureFlag } from '@velajs/feature-flags';

@Controller('/checkout')
class CheckoutController {
  @FeatureFlag('new-checkout')                       // 404 when off (route looks hidden)
  @Get('/v2') v2() { /* … */ }

  @FeatureFlag('beta', { onDisabled: 'forbidden' })  // 403 when off
  @Get('/beta') beta() { /* … */ }
}
```

`FeatureFlagsModule` registers `FeatureFlagGuard` app-wide by default, so every
`@FeatureFlag()` route is gated without `@UseGuards`: a flagged route is never
reachable ungated. To gate per route instead, pass `globalGuard: false` and add
`@UseGuards(FeatureFlagGuard)` to each gated controller or handler (not both, or
the flag is evaluated twice per request). `isGlobal: true` separately makes the
service visible to every module.

The route guard opens only when the driver returns the literal boolean `true`
and evaluation completed without error. Non-boolean driver output, a missing
request context, a throwing context resolver, or an unavailable evaluator all
deny with the decorator's configured 404/403 behavior. Manifest keys use
own-property lookup, and per-call targeting cannot replace trusted identity
fields supplied by the request-context resolver.

Feature flags control rollout and presentation; they do **not** grant authority.
Keep authentication, tenant membership, ownership checks, and permission guards
on every flagged operation. A client able to guess or observe a flag value must
still be unable to perform an unauthorized action.

## Drivers

The in-memory driver ships here; runtime-specific drivers live in their platform packages
(`@velajs/cloudflare` ships Flagship-binding and KV drivers), all implementing the same contract:

```ts
export interface FeatureFlagDriver {
  readonly name: string;
  getBoolean(key: string, fallback: boolean, ctx?: FlagContext): Promise<boolean>;
  getString(key: string, fallback: string, ctx?: FlagContext): Promise<string>;
  getNumber(key: string, fallback: number, ctx?: FlagContext): Promise<number>;
  getObject(key: string, fallback: object, ctx?: FlagContext): Promise<unknown>;
}
```

A driver returns the caller's `fallback` (never throws) when it can't resolve a key; the service
additionally absorbs any thrown error into the same fallback and logs a warning.

## Validating object flags

Object drivers return `unknown`. Pass a parser and an explicit typed fallback to
the service; its result type is inferred from the parser. A failed read or parse
returns the fallback, and `getObjectDetails` reports parser failures as `ERROR`.

```ts
const parseLayout = (value: unknown): { columns: number } => {
  if (
    typeof value !== 'object' || value === null ||
    !('columns' in value) || typeof value.columns !== 'number'
  ) {
    throw new TypeError('layout.columns must be a number');
  }
  return { columns: value.columns };
};

const layout = await flags.getObjectValue('layout', parseLayout, { columns: 2 });
const details = await flags.getObjectDetails('layout', parseLayout, { columns: 2 });
```

A schema's `.parse` function can be passed directly. Object evaluations require
the fallback because an absent flag cannot produce an arbitrary application type.
Primitive reads still use matching manifest defaults. `all()` evaluates manifest
objects as broad object values; use a parsed object method for domain-specific fields.

## Typed flag keys

Augment `FeatureFlagRegistry` to type the service methods and the `@FeatureFlag()` decorator:

```ts
declare module '@velajs/feature-flags' {
  interface FeatureFlagRegistry {
    'new-checkout': boolean;
    layout: string;
  }
}
```

## Testing

`@velajs/feature-flags/testing` re-exports the memory driver (the fake) plus a zero-DI helper:

```ts
import { createTestFeatureFlags } from '@velajs/feature-flags/testing';

const { service, driver } = createTestFeatureFlags({ 'new-checkout': true });
expect(await service.getBooleanValue('new-checkout')).toBe(true);
driver.set('new-checkout', false);
```
