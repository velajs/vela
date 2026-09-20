# Live protocol, typed query definitions, and application-owned resources

Status: implementation complete; final focused verification passed. This lane did not commit, publish, install dependencies, or change manifests/lockfiles. Existing uncommitted protocol/live work was preserved. The coordinating task owns the combined workspace build and API snapshots.

## Architectural result

A portable `defineLiveQuery({ args, result })` descriptor supplies runtime parsers and inferred types to both the server decorator and browser client. The core captures the actual typed handler in a closure rather than reconstructing a callable signature through reflection. Input is parsed once per active subscription; final pipeline output is parsed after interceptors and before caching, diffing, or publication. Persisted subscriptions contain the original input, which is reparsed when a resolver is restored.

The protocol remains the shared codec with no runtime schema dependency. Valid JSON transport fields remain `unknown` until their application parser validates them. Canonical encoding uses exhaustive discriminated-union construction and preserves existing wire bytes.

A driver and cursor log belong to one application container. Module options contain resource factories, including factories capturing injected Cloudflare bindings. Hibernated state is reconstructed from validated data instead of being asserted into a trusted subscription record.

## Implemented

- `live-protocol/src/frames.ts`: exhaustive frame/row construction replaces asserted dictionary lookups. `canonicalLiveFrame` returns `LiveFrame`. Unknown JSON validation reads own property descriptors and rejects getters without executing them, sparse arrays, custom array properties, hidden/symbol properties, nonstandard prototypes, cycles, depth and size violations. Recursive validation exceptions fail closed.
- `live-protocol/src/delta.ts`: a single insertion-ordered map replaces separately maintained key arrays and asserted lookups. Applying row-operation variants is exhaustive. Existing ordering, correctness fallback and byte-cost delivery behavior remain intact.
- `live-protocol/src/conformance.ts`: deep equality no longer asserts dictionaries; JSON parsing receives `unknown` before validation.
- `live-protocol/src/query.ts`: exports portable `LiveQueryDefinition<Args, Result>` and `defineLiveQuery`. The helper has no Zod dependency. Its compiler fixture checks inference and rejects missing/incompatible result parsers.
- Core `live.module.ts`: driver/log factories are invoked per container, async factories are supported, and checked `defineProvider` descriptors infer injected dependencies. Removed the shared `perAppLiveDriver` wrapper and environment forwarding.
- Core `live.persistence.ts`: reconstructs subscription records from plain own enumerable data properties. It validates names, tags, keys, safe-integer expiry and bounded inert identity claims. Functions, accessors, classes, cycles and excessive identity data fail closed. Cached JSON/cursors and extra fields are never restored. No unchecked `SubscriptionRecord` assertion remains.
- Core `live.decorators.ts` / `live.types.ts`: `@LiveQuery(name, definition, options)` constrains method arguments/results and args-dependent tag/coalescing callbacks. Typed closures retain parsed arguments and the actual method. The old optional `options.parse` path and assertion-based metadata erasure are removed.
- Core `live.engine.ts`: parses subscription input and restored original input, recomputes validated tags, invokes captured typed handlers, and validates final interceptor output before JSON/caching/deltas. Invalid results cannot advance an existing cached baseline. Identity snapshots omit framework subscription bookkeeping and validate expiry. No non-const type assertion remains in the engine, decorators or persistence helper.
- Built-in presence resolver now has concrete argument/result parsers. The live documentation, portable schema documentation, major changesets and live-todo example use the new contract.
- Live-todo example shares one schema file between server/browser; the browser no longer asserts DOM elements, WebSocket wrappers, JSON envelopes, presence metadata or query values. `makeAppModule` has checked store providers, typed module imports, and explicit `liveModule` / `websocketModule` overrides for the Cloudflare variant. The Cloudflare lane owns its Worker implementation.
- Feature-flag object retrieval was also changed to parser-inferred values, with checked module providers. Its separate API details and 39-test verification are in [feature-flags.md](feature-flags.md).

## Consumer contract

```ts
const todos = defineLiveQuery({
  args: z.object({}),
  result: z.array(z.object({ id: z.string(), text: z.string() })),
});

@LiveQuery('todos.list', todos, { tags: ['todos'] })
list() { return this.todos.all(); }

const client = createLiveClient({
  url: location.origin,
  queries: { 'todos.list': todos },
});

LiveModule.forRoot({
  driver: () => durableObjectLive({ namespace, gatewayPath: '/rooms/:id/ws' }),
  log: () => durableObjectCursorLog(),
});
```

`driver?: () => LiveDriver | Promise<LiveDriver>` and `log?: () => CursorLog | Promise<CursorLog>` replace resource-object options. Each invocation must return a fresh instance. To capture application-local environment/configuration, use `LiveModule.forRootAsync({ inject: [ENV], useFactory: env => ({ driver: () => ... }) })`. There is no object overload, old two-argument query decorator, old optional parser path, or compatibility wrapper.

## Final verification

- Protocol: `tsc --noEmit`, lint, all 35 runtime tests, and the separate compile-only query descriptor fixture passed.
- Core: final `tsc --noEmit` passed after the invariant DI declarations were rebuilt. Its included `live-definition.typecheck.ts` checks sync/async handlers and rejects incompatible args/results, incompatible callbacks, missing descriptors and old parser options.
- Core live runtime: 72 tests passed across `live.test.ts`, `live-coalescing.test.ts`, `live-persistence.test.ts`, `live-schema.test.ts`, `live-openness.test.ts` and `live-delta-wire-size.test.ts`.
- Live-todo: final `tsc --noEmit` passed across Worker, Node server, shared contracts and browser sources against the rebuilt package declarations.
- Lint of core live sources returned no errors. Warnings remain for intentional sequential delivery awaits, control-character validation regexes and factory parameter shadowing.
- Regressions cover separate resources for two applications using the same module, async factories capturing separate configs, malicious persisted values, expired identities, fresh snapshots after restoration, args transformations running once per subscription, raw-input reparsing on restore, typed method binding, stripped private result fields and interceptor-corrupted output preserving the prior valid cache baseline.

## Remaining boundaries and integration ownership

- A valid wire frame proves transport shape and inert JSON, not a query's application domain type. `args`, `meta`, `snapshot` and row values appropriately remain `unknown` until parsed. The client lane owns parsing snapshots/reconstructed deltas before publication and its compiler/integration coverage.
- Existing reflection assertions in `live-coalescing.ts` remain outside this bounded change. The parser/handler/persistence boundary no longer depends on them.
- Static frame types still permit some cursor/epoch combinations rejected by runtime guards; range/byte bounds and query-dependent key identity also require runtime checks. These guards remain the authority for external wire data.
- The coordinating task owns final package builds, API snapshot regeneration and cross-package examples. Cloudflare owns native binding/transport implementations; client/CLI owns schema-bearing consumers and generation. The live-todo example source is ready and its full typecheck is green.
