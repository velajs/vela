# Cloudflare native environment implementation

Status: implementation, consumer migration, and required runtime/type/package checks pass against the final invariant-token core and live definitions. The additionally assigned live-todo Worker is migrated and the full live-todo typecheck passes with the live lane's shared module composition changes. No commits, publication, or deployment.

## Architecture and capabilities

- `createCloudflareApp(Module, { env, envToken })` registers the native environment through the core `configureContainer` hook before providers or lifecycle. The token's type controls the supplied environment (`NoInfer` prevents weakening from the env argument). Hono middleware receives the same inferred native type.
- `createCloudflareWorker(Module, { envToken, ... })` memoizes one bootstrap promise per environment object in a `WeakMap`. Concurrent cold events share construction; different environments get separate containers. Rejected construction is evicted for retry. No process globals, ambient environment slot, Node imports, or permanent environment map were added.
- Explicit app fetch/queue/scheduled and adapter middleware reject a different environment identity. Internal invocation transport reenters with the bound environment. Request/event scope still rebuilds per dispatch.
- Removed BindingRef/EnvRef, the binding initializer, all thin per-binding modules/services, obsolete binding tokens, and broad legacy CloudflareEnv/registration types. KV, D1, R2, queue, AI, Vectorize, Hyperdrive, and DO capability is supplied by the native typed Env directly.
- Storage module options receive typed native R2 buckets and an explicit signing secret from an async factory. Existing signed URL/expiry/root/attachment semantics remain covered.
- Each live driver and cursor log is instantiated by a core LiveModule factory per application. `durableObjectLive({ namespace, gatewayPath })` accepts a typed RPC namespace, retains no mutable global environment, and DO-local mode affects only that application's driver. DO bootstrap gets native env before factories/lifecycle. Its own SQLite log and local invalidation mode are prepared before user lifecycle hooks. Typed namespace interfaces also remove the former broadcast/live RPC double assertions.
- WebSocket routing consumes core trusted request identity and preserves principal, tenant, expiry, conflict checks, and spoof-header stripping. Runtime binding-name metadata is handled through an explicit checked reflection boundary.
- Root imports are Node-readable. Native `VelaWebSocketDurableObject` and `VelaNonceDurableObject` classes live at `@velajs/cloudflare/durable-objects`. The generated WebSocket class preserves broadcast, live invalidation, and PITR RPC types in its constructor result.

## Deferred integration extraction

Per the coordinator's explicit scope decision, active email/workflow source directories, corresponding tests, root exports, and static mail imports were removed. No optional subpath or compatibility implementation remains. Standalone `mail`/`workflow` repositories were untouched.

Uncommitted integration source/test work was preserved under `.modernization/deferred-cloudflare/src`, plus the previous Cloudflare README at `.modernization/deferred-cloudflare/README.before-native-env.md`. These are archived material outside the active package. The coordinator owns removal of peers/dev dependencies/release prerequisites/test-shims/build configuration and the shared workspace.

## Additional authorized cache contract work

The coordinator assigned `vela/src/cache/{cache.types,cache.service,cache.store,tiered-cache.store,cache.interceptor}.ts` and dedicated tests to this lane.

- Sync/async/memory/tiered/KV cache reads now return `unknown`; arbitrary caller-chosen `get<T>` is removed.
- `CacheService.getParsed(key, parser)` infers the domain value from the parser; absence returns undefined, invalid stored data throws the parser's error.
- The HTTP interceptor replays/caches validated bounded JSON values only. Responses, class instances, accessors, functions, cycles, nonfinite numbers, and overly deep structures are rejected. Invalid cached entries are evicted. Existing cache authentication partitioning, opt-in requirement, Set-Cookie bypass, and Response bypass remain intact.
- Cloudflare KV and Flagship flag drivers follow the feature-flags lane's raw unknown object-value contract; scalar checks use genuine narrowing predicates. No cast is used to promise an arbitrary object shape.

## Modified files

Cloudflare runtime: `src/cloudflare-factory.ts`, `src/cloudflare-application.ts`, new `src/environment.ts`, `src/index.ts`, `src/decorators/env.ts`, new `src/durable-objects.ts`; removed binding/env refs, initializer, tokens, types, all per-binding modules and services, email/workflow integrations.

Binding consumers: `src/services/{kv-cache.store,kv-flag.driver,flagship-flag.driver}.ts`; `src/storage/{storage.module,storage.types,storage-manager.service,storage.controller}.ts`.

DO/live/WS: `src/websocket/{do-bootstrap,do-live,websocket-routing,websocket.durable-object,cloudflare-websocket.module,room-id,broadcast,index}.ts`; split `src/nonce/durable-object-nonce.store.ts` into Node-readable factory plus `nonce-validation.ts` and `nonce.durable-object.ts`; `src/nonce/index.ts`.

Tests: new/reworked `entrypoint-bindings.test.ts` and `workers/entrypoint-bindings-runtime.test.ts`; migrated live/WS, storage, queue/cron, factory options, OpenAPI, cache/flag/nonce suites and Worker entry; removed tests of deleted wrapper APIs. Both example source trees and bindings-lab consumer tests/readme migrated. Main README and major changeset `native-application-environments.md` added/rewritten.

Core cache files listed above plus `vela/src/__tests__/tiered-cache.test.ts` and new `cache-value-safety.test.ts`. Core module/provider/DI changes, dependency manifests/configuration/lockfiles, and other lanes' modifications are not owned by this report.

Additional bounded assignment: `vela/examples/live-todo/src/worker.ts` now uses native `WorkerEnv` injection, checked store registration, a typed Durable Object namespace, per-application live driver factories, the native DO subpath, and `createCloudflareWorker`. Its KV JSON is treated as unknown and parsed by the shared todo-list schema. Shared app-module composition changes belong to the live lane.

## Verification

Baseline: Cloudflare source typecheck passed; 28 unit files / 177 tests passed before changes.

Current checks:

- Cloudflare unit suite: 15 files / 117 tests passed after the native environment, descriptor, identity, cache/flag, and required shared live-query definition migrations. Rechecked with the async-DI repair and current core live definitions.
- Cloudflare source/test typechecks and package build passed against the refreshed descriptor-only core, native environment, cache, feature-flag, and portable live-query declarations. The dedicated live fixture typecheck also passed via `.modernization/cloudflare-live-typecheck.json`. The returned worker is compile-checked against native `ExportedHandler<Env>` (including readonly queue batches). `publint` and `attw --profile esm-only` passed for both entrypoints.
- Root package built import passed in native Node: no `cloudflare:workers` runtime dependency loaded.
- Bindings lab source/test typecheck and three public-consumer tests passed.
- Native WebSocket example typecheck passed.
- Dedicated cache suite passed 3 files / 23 tests after descriptor migration, including parser inference and malformed cached-value regressions. Dedicated TypeScript checks passed via `.modernization/cache-typecheck.json`, including negative generic-cache-use assertions.
- Workers package script: 3 files / 10 tests passed, including cold queue/cron native DO/live invalidation, WebSocket security/expiry/hibernation, PITR, and real KV/D1/R2 I/O before lifecycle. The new regression exposed a core async-constructor double-execution bug, fixed by the owning core lane without reordering providers.
- Lint completed without errors; existing stylistic warnings remain (decorated empty/static module classes, deliberate loop awaits, etc.). Whole-package Cloudflare `format:check` now passes, including the coordinator's package/configuration corrections.
- Final core rebuild recheck: all Cloudflare and dedicated cache/live TypeScript checks, 117 Cloudflare unit tests, 10 Workers tests, three bindings-lab consumer tests, both Cloudflare example typechecks, build, Node root import, publint, and attw passed. The cache verification command also ran the full core suite successfully: 115 files / 1,242 tests.
- The full live-todo example typecheck passed after integration of the shared module options and native Worker migration.

Use package scripts (`pnpm --dir cloudflare test:workers`) for Workers verification. A direct root `.bin/vitest` invocation produced a duplicate-runner/module-identity collection error while the package script correctly runs workerd.

## API migration

1. Inject a generated `InjectionToken<Env>`; delete binding module imports/services and `EnvService.get<T>`.
2. Build with `{env,envToken}`, or export the lazy worker facade.
3. Use checked `defineProvider(TOKEN, {inject,useFactory/...})` and inferred `app.get(TOKEN)`. Every `useFactory` strategy requires explicit `inject`, including `inject: []` when there are no dependencies; this applies to `lazyProvider` and async module options too. All active owned factories already declare their dependency tuples.
4. R2 disks use `bucket: env.FILES`; storage receives `secret: env.APP_SECRET` explicitly.
5. Live options use `driver: () => ...` and `log: () => ...`; the CF driver takes `namespace`, not a name.
6. Native DO classes import from `/durable-objects`; WebSocket DO construction takes `{envToken}`.
7. Cache reads return unknown; parser-based reads replace `get<T>`. Object flag values are validated by the feature-flags service's parser API.
8. Email/workflow integrations are outside the active API package.

## Assertions and remaining risks

No unsafe assertions remain in the changed application/environment APIs, cache APIs, KV/Flagship drivers, DO bootstrap, live driver/log path, broadcast helper, WebSocket routing/shell, or split nonce implementation. `as const` remains in test parameter lists and is not a conversion.

Decorator metadata is an unavoidable erased boundary: `getMetadata<WebSocketGatewayOptions>` reads the framework-authored gateway descriptor; method invocation checks the reflected member before `Reflect.apply`. Runtime gateway binding names validate the actual operations and returned Response through unknown reflection, without pretending an arbitrary value is a full platform namespace. Generic DI resolution belongs to core's documented checked-token boundary.

Pre-existing test doubles in broad legacy WS/storage/example fixtures still contain casts representing incomplete native platform fakes. New environment/type tests and real KV/D1/R2/cold-event regressions use native contracts. Untouched transport/storage internals outside this migration may retain historical casts; this report does not claim a whole-package cast audit.

The async-DI regression now passes against the coordinator's repair: classes await factory dependencies once, and bootstrap failures propagate. The owned live fixture now uses the shared portable `defineLiveQuery({args,result})` contract, with Zod argument/result schemas; its final unit and dedicated TypeScript checks passed. The final invariant-token declarations and mandatory factory inject tuples pass all owned core/Cloudflare checks; final workspace integration belongs to the coordinator.
