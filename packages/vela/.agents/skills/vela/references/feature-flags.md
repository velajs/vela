# Feature Flags (`@velajs/feature-flags`)

Edge-first, driver-based feature flags. One small `FeatureFlagDriver` contract backs every runtime; an in-memory driver ships in the box (and doubles as the test fake). The package is edge-pure (no deps beyond peers `@velajs/vela` + `hono`). Subpaths: `.` and `./testing`. Server-only — no React/client hooks.

## Setup — `FeatureFlagsModule.forRoot`

Authored on vela's `defineModule` (and `lazy: true`), so `forRoot` / `forRootAsync` come for free:

```ts
import { FeatureFlagsModule, memoryFlagDriver } from '@velajs/feature-flags';

@Module({
  imports: [
    FeatureFlagsModule.forRoot({
      drivers: [memoryFlagDriver({ values: { 'new-checkout': false } })],
      manifest: { 'new-checkout': false, layout: 'v1' },
      context: (ctx) => ({ requestId: ctx.id }),   // merged into every evaluation
    }),
  ],
})
class AppModule {}
```

`FeatureFlagsOptions` — every field is optional:

| Option | Type | Notes |
|---|---|---|
| `drivers` | `FeatureFlagDriver[]` | Omit → a single `MemoryFlagDriver` named `"memory"`. |
| `default` | `string` | Name of the driver the injected service targets. Defaults to `drivers[0].name`. |
| `manifest` | `FlagManifest` (`Record<string, FlagValue>`) | Declared flags + defaults. Powers manifest defaults and `service.all()`. |
| `context` | `(ctx: RequestContext) => FlagContext \| Promise<FlagContext>` | Per-request context resolver merged into every evaluation; skipped outside request scope. |
| `globalGuard` | `boolean` | Registers `FeatureFlagGuard` app-wide via `APP_GUARD`. Structural: pass it next to a `forRootAsync` factory. |

`isGlobal: true` is a `forRoot` **extra** (not a field on the typed options): it makes the module global, nothing more. `forRootAsync({ imports, inject, useFactory, globalGuard? })` returns the other options from the factory.

## Evaluating — `FeatureFlagsService`

Inject via `FEATURE_FLAG_TOKENS.Service`. The service is `@Transient` (a fresh instance per injection) and **never throws** — a failed driver read (or a thrown error) returns the fallback with a logged warning:

```ts
import { FEATURE_FLAG_TOKENS, FeatureFlagsService } from '@velajs/feature-flags';

@Injectable()
class CheckoutService {
  constructor(@Inject(FEATURE_FLAG_TOKENS.Service) private readonly flags: FeatureFlagsService) {}

  async run() {
    if (await this.flags.getBooleanValue('new-checkout')) { /* … */ }
    const layout = await this.flags.getStringValue('layout');       // manifest default when unset
    const details = await this.flags.getBooleanDetails('new-checkout'); // { flagKey, value, reason, errorMessage? }
    const everything = await this.flags.all();                       // evaluate the whole manifest
  }
}
```

Primitive reads `getBooleanValue`, `getStringValue`, and `getNumberValue` take `(key, defaultValue?, context?)`. Their fallback order is explicit default → matching manifest value → the primitive zero value. Object reads require runtime evidence: `getObjectValue(key, parse, fallback, context?)` and `getObjectDetails(key, parse, fallback, context?)` infer from `parse(unknown)` and use the required typed fallback on driver/context/parser failure. For example, `flags.getObjectValue('layout', value => LayoutSchema.parse(value), { columns: 1 })`. Details contain `{ flagKey, value, reason, errorMessage? }`; current reasons are `STATIC`/`ERROR`.

- `all(context?)` evaluates every manifest key (method chosen from each declared default's type) → `{ key: value }`.
- `use(name)` returns a **new** immutable service bound to a different registered driver (throws `FeatureFlagError` on unknown name).
- `forRequest(ctx)` returns a **new** service whose evaluations merge `options.context(ctx)` — the guard does this automatically.
- `get driverName` is the current driver's name.

## Gating routes — `@FeatureFlag` + `FeatureFlagGuard`

```ts
import { FeatureFlag, FeatureFlagGuard } from '@velajs/feature-flags';

@UseGuards(FeatureFlagGuard)                          // or app-wide via forRoot({ globalGuard: true })
@Controller('/checkout')
class CheckoutController {
  @FeatureFlag('new-checkout')                        // flag off → 404 (route looks hidden)
  @Get('/v2') v2() { /* … */ }

  @FeatureFlag('beta', { onDisabled: 'forbidden' })   // flag off → 403 (route revealed, access denied)
  @Get('/beta') beta() { /* … */ }
}
```

The guard reads the handler/controller metadata, evaluates `getBooleanValue(key)`, and when the flag is off throws `NotFoundException` (default, `onDisabled: 'notFound'`) or `ForbiddenException` (`onDisabled: 'forbidden'`). Handlers **without** `@FeatureFlag` metadata pass through untouched, so the guard is safe to register app-wide. It does not inject `REQUEST_CONTEXT` (that would force request scope and break lazy materialization) — it reads the request context off the per-request child container instead, so `context` still runs for the gate decision.

## Drivers — `FeatureFlagDriver`

Every backend implements the same four-method contract; a driver **must return the caller's fallback (never throw)** when it cannot resolve a key:

```ts
export interface FeatureFlagDriver {
  readonly name: string;
  getBoolean(key: string, fallback: boolean, ctx?: FlagContext): Promise<boolean>;
  getString(key: string, fallback: string, ctx?: FlagContext): Promise<string>;
  getNumber(key: string, fallback: number, ctx?: FlagContext): Promise<number>;
  getObject(key: string, fallback: object, ctx?: FlagContext): Promise<unknown>;
}
```

`MemoryFlagDriver` (via `memoryFlagDriver({ name?, values? })`) is the in-package driver + test fake: `set(key, value)`, `delete(key)`, `reset(values?)` return `this` (chainable), while `has(key)` returns `boolean` (not chainable); it ignores the evaluation context (no targeting). Runtime-specific drivers live in their platform packages — **`@velajs/cloudflare` ships `flagshipFlagDriver` and `kvFlagDriver`** against this exact contract (see `references/cloudflare.md`). `FeatureFlagDriverRegistry` / `buildDriverRegistry(options)` back the driver lookup; `FeatureFlagError` is thrown only for config-time faults (unknown/duplicate/empty driver set), never during evaluation.

## Typed flag keys

Augment `FeatureFlagRegistry` (the flag-name analog of `VelaRouteMap`) to type the service methods and the decorator; un-augmented, `FlagKey` falls back to `string`:

```ts
declare module '@velajs/feature-flags' {
  interface FeatureFlagRegistry {
    'new-checkout': boolean;
    layout: string;
  }
}
```

## Testing — `@velajs/feature-flags/testing`

The subpath re-exports the memory driver plus a zero-DI helper — a real `FeatureFlagsService` over an in-memory driver, no app bootstrap:

```ts
import { createTestFeatureFlags } from '@velajs/feature-flags/testing';

const { service, driver } = createTestFeatureFlags({ 'new-checkout': true });
expect(await service.getBooleanValue('new-checkout')).toBe(true);
driver.set('new-checkout', false);                 // flip flags on the driver, assert on the service
```

`createTestFeatureFlags(values?, { manifest?, context? })` returns `{ service, driver }`.
