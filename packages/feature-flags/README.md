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
reachable ungated. To gate per route instead, pass `guard: 'none'` and add
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

A driver returns the caller's `fallback` for unresolved keys. Unexpected failures may
reject; the service absorbs them into the same fallback and logs a warning.

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
    beta: boolean;
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

## Evaluation metadata

A driver can implement `getBooleanDetails`, `getStringDetails`, `getNumberDetails`
and `getObjectDetails` alongside its value methods. The service calls the matching
method once and preserves `reason`, `variant`, `errorCode`, and `errorMessage`.
Reasons are provider-defined strings. Providers without details report `UNKNOWN`;
a value equal to the fallback is not evidence of either a hit or a miss. Missing
native reasons also become `UNKNOWN`. Malformed values or metadata produce the
caller fallback with `reason: 'ERROR'` and `errorCode: 'GENERAL'`.

A provider result with an error code or `reason: 'ERROR'` always returns the
caller's fallback, including object fallbacks without parsing them again. Route
guards explicitly use `false` as the fallback and deny any error code, even when
its reason is `DEFAULT`. Value-only providers must honor the supplied fallback;
the service cannot reconstruct errors they conceal. Feature flags are rollout
controls and do not replace application authorization.

The Cloudflare Flagship driver validates targeting context as strings, finite
numbers, and booleans. Nested objects, arrays, null, undefined attributes and
non-finite numbers fail with `INVALID_CONTEXT` on detail reads before contacting
the binding. Trusted request identity still wins when contexts are merged.

```ts
const result = await flags.getBooleanDetails('new-navigation', false, { plan: 'trial' });
// Native details may include TARGETING_MATCH, a variant, or FLAG_NOT_FOUND.
if (result.errorCode !== undefined) {
  // The value is the supplied fallback; report the code through application telemetry.
}
```

Migration: detail reads from drivers without metadata now return `UNKNOWN`
instead of the previously synthesized `STATIC`. Accept provider-defined reason
strings and use `errorCode` as well as `reason === 'ERROR'` when checking failure.
See the [native Flagship contract](https://developers.cloudflare.com/flagship/binding/types/)
and [failure behavior](https://developers.cloudflare.com/flagship/binding/methods/).
