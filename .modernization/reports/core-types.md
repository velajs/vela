# Core TypeScript architecture audit and implementation

Scope: `vela/src`, excluding OpenAPI and tests in the original scan. The initial scan found 216 production files; detailed work covered DI, module registration, bootstrap/runtime adapters and configuration. Classification follows `/Users/kauan/.agents/skills/analyze-typescript/SKILL.md`: C1 explicit `any`, C2 unsupported assertions, C3 implicit `any` from runtime APIs. Counts of syntax are not presented as type-safety coverage.

## Implemented

### Typed provider authoring and resolution

`container/types.ts:17–50` separates an erased runtime `Token` identity from `TypedToken<T>`. `InjectionToken<T>` is invariant, so assigning a numeric token to `InjectionToken<unknown>` is rejected. Erasing it to `Token` permits lookup with an unknown result but removes the capability to author a binding. The invariant field is **protected**, because declaration emission erases a private field's function annotation; source-only checks originally missed that emitted-package hole, which was found by the testing lane and corrected.

`container/types.ts:196–210` defines the single `defineProvider(token, options)` authoring API. It infers the value from the actual token, checks one exclusive value/class/alias/factory strategy and returns a nominal `ProviderDefinition`. Its non-exported implementation class has private state; object literals and object spreads cannot fabricate checked definitions. Provider descriptors, their copied dependency tuples and token default-factory options are frozen snapshots.

Factory strategies require an actual `inject` tuple, including `inject: []` for zero dependencies. Factory arguments derive from that tuple and the return value must satisfy the provided token. Explicit generic tuples cannot fabricate dependencies when the runtime array is omitted. `ForwardRef<K>` captures the actual returned token and recursively infers its resolved type.

`registry/types.ts:129,143,153` and `module/define-module.ts` now accept only class providers or checked definitions. Container registration/replacement uses the same boundary. There is no public plain-provider-record overload. Runtime-erased `ProviderOptions` and descriptor extraction remain internal implementation inputs, not an alternate exported registration path.

`Container.resolve`, `resolveAll`, `resolveAsync`, `ModuleRef.get/resolve` and `VelaApplication.get` infer from tokens. Raw strings/symbols return `unknown`. `setRequestInstance` also rejects erased/widened token writes. `ConfigurableModuleBuilderOptions<Opts>` ties a supplied options token to the builder's options type. Global component registration checks the actual guard/pipe/interceptor/filter/middleware contract.

Compile-negative regression cases in `__tests__/container-types.test.ts` cover:

- Reader-selected result types, raw string/symbol values, incompatible provider results/classes/aliases and mixed strategies.
- Plain `@Module`/dynamic module provider literals and spread-based descriptor fabrication.
- Explicit `defineProvider<unknown>`, `<InjectionToken<unknown>>`, `<TypedToken<unknown>>` and `<Token>` attempts to rebind a numeric token incorrectly, plus erased variables and request cache writes.
- Explicit nonempty dependency generics without runtime `inject` in provider, lazy provider, async options and generated module APIs.
- A guard slot supplied with a pipe-shaped object.

### Bootstrap and asynchronous dependency correctness

`factory/adapter.ts:45`, `factory/bootstrap.ts:33` and `factory.ts:46–51` add and compose `configureContainer`. Framework primitives are registered first; adapter hooks then run in declaration order, followed by the caller hook. Every hook is awaited before module loading or eager construction. Rejection aborts bootstrap, and a later application creates a fresh container.

`container/container.ts:918–1055` recursively awaits constructor dependencies as well as factories. In-flight singleton/request construction is shared per registration and owning container; transient resolution remains independent. Legitimate `undefined` results are cached using value cells. Circular paths are checked before joining pending work; explicitly forward-referenced constructor cycles retain the existing lazy proxy behavior. Failed pending work is removed, permitting a later explicit retry.

`module/module-loader.ts:541` now propagates construction failures. The old catch-and-continue could leave a partial app, and the old async class fallback invoked asynchronous factories synchronously before rerunning them later. The Cloudflare lane's native D1/Worker regression confirmed this caused repeated side effects. Factory dependencies now resolve once in their declaring module scope; the global fallback that bypassed visibility and repeated failing work was removed.

### Honest configuration values

`config/register-as.ts:56–68` requires an explicit typed environment token and creates a real invariant namespace `InjectionToken<TConfig>`. It no longer disguises `Symbol.for` as a token or invents an environment shape from a caller-selected generic.

`ConfigService` is nongeneric: dynamic path reads return `unknown`, `getAll()` returns `Record<string, unknown>`, and `parse(path, schema)` derives its result from the schema's parser. Typed namespace consumers resolve the namespace's declared KEY. The runtime and compile-negative cases are in `__tests__/config-type-boundaries.test.ts`.

## Remaining ranked findings

### P2 — C2: required custom decorator data is exposed as optional

Locations: `http/decorators.ts:239–255`, `http/lazy-param.decorator.ts:44–60,71`.

The returned decorator accepts `data?: TData`, but its factory is called with `data as TData`. A factory requiring a string may receive undefined. Require data when the factory's data type excludes undefined. The lazy decorator also claims an arbitrary T from an object Proxy; expose a thunk or constrain supported values instead of claiming primitive/promise semantics from an object proxy.

### P2 — TypeScript structural class identity remains an explicit-widening limitation

Locations: `container/types.ts:4,49,196–210`.

Invariant injection tokens close the concrete widening hole, but ordinary class constructors are structurally covariant in TypeScript. A caller can deliberately widen `typeof Service` to `Type<unknown>` before using it as a custom binding token, losing the original instance contract while retaining the same runtime constructor identity. The same underlying constructor can still be referenced elsewhere with its original type. Preventing this entirely would require custom rebindings to use invariant injection tokens exclusively; automatic `providers: [Service]` construction can remain safe without custom class rebinding. This lane preserves custom class providers and records this residual limit rather than claiming a fully sound registry under arbitrary explicit widening. `any`, unchecked user assertions and mutation outside TypeScript's readonly discipline are likewise outside static guarantees.

## Final public-boundary follow-up

- `entrypoint/entrypoint.registry.ts:114` no longer accepts `ofKind<M>(string)`. String-only lookups return unknown metadata and copy the result array; the optional parser overload infers its output from `(unknown) => M`. Queue, scheduled and live runtime consumers validate the concrete fields they use. WebSocket consumers verify the actual `WsDispatcher` instance/path relationship and recover canonical metadata from its owned gateway list. No generic type predicate claims callback signatures from an object shape.
- `module/configurable-module.builder.ts` now stores typed immutable builder state. Every naming/extras transition returns a new branch and calls `defineModule` without the old double assertions. The public constructor has only the options type parameter, preventing an explicit method-name generic from fabricating unperformed runtime state. Retained original, renamed, factory-method and extras branches have runtime and negative type regressions.
- Workspace migrations are limited to core and the Cloudflare API runtime. Excluded mail inbound still uses the retired generic lookup and is not part of the active API verification scope.
- Focused follow-up verification: **7 files / 115 tests passed**, plus core source and source type-test checks. Public-package negative cases were extended in `type-tests/provider-package.ts`; root owns the required final declaration rebuild and full verification.

## Closed by cooperating lanes

- Core Hono/request ownership is now concrete (`http/hono.types.ts`): framework bindings are object-valued and request variables unknown until narrowed; request containers live in a private WeakMap accessed through `getRequestContainer`, not mutable `c.get('container')` state. Native binding types remain attached to explicit DI tokens. Root implemented and verifies this boundary.
- Request metadata now uses invariant `RequestContextKey<Value>` storage; raw keys return unknown (`http/request-context.ts`).
- ExecutionContext accessors use concrete contracts instead of reader-selected result generics.
- The empty class/schema DTO fiction was removed in favor of `defineDto` descriptors (`validation/dto.ts`) by the endpoint lane.
- HTTP response/status conversion was modernized by the response lane, with dedicated negative/status tests.
- Cache values now return unknown until validated, owned by the Cloudflare lane.

## Necessary runtime boundaries

- `Type`/`Constructor` constructor-argument `any[]` permits heterogeneous constructors and reflection. Replacing it with `unknown[]` rejects legitimate classes; it is contained rather than propagated into instance values.
- `container/container.ts:353` restores the token/registration relation erased by heterogeneous storage. Public writers now pass checked descriptors; default-token registration uses the token's own copied factory. Request/in-flight caches document the same registration/value relation.
- Decorator `design:paramtypes` cannot prove constructor parameter compatibility or recover erased interfaces. Checked factory dependency tuples are the fully typed authoring path; reflection remains a runtime path. No predicate pretends that checking a callable reconstructs its parameter tuple.
- Synthetic APP_* tokens are connected to their original component slot by the module loader; its single private map assertion restores that relation.
- Reflective controller invocation checks object and callable boundaries but cannot prove method parameters or response schemas from reflection alone.

## Verification

- Core TypeScript source, type-test and dispatch-test configurations pass.
- Core declarations rebuilt successfully. `tsconfig.package-tests.json` checks `type-tests/provider-package.ts` via the public `@velajs/vela` export against generated `dist/*.d.ts`, with no core source in its file list. All explicit-widening, module-literal and missing-runtime-dependency negative cases pass. This catches declaration-emission variance loss that source-only tests cannot detect.
- Final full core Vitest run: **115 files / 1,242 tests passed**.
- Dedicated DI/bootstrap/config group: **5 files / 17 tests passed**.
- Scoped lint: no errors; existing style and intentional ordered-await warnings remain. Modified primary implementation files were formatted.
- Cloudflare native regression: coordinator reports **10/10 passed**, including constructor-before-async-factory native I/O ordering.
- Cross-package declaration builds, downstream packages, snapshot updates and complete Workers integration are coordinated by the root task.
