# API type architecture audit

Read-only source audit, 2026-09-20. Scope: `vela`, Cloudflare API/runtime integration, CRUD, auth/authz, HTTP/live client, and `live-protocol`. Categories: M1–M7, H2, H4, L2 from `analyze-typescript`. Deferred AI/workflow/email features were not reviewed. The package inventory contains 428 non-test TypeScript files; this report selectively traces public contracts rather than claiming a complete runtime or cast audit. Concurrent modernization is in progress, so locations describe the observed declarations and must be rechecked before editing.

The central change should be **types inferred from a supplied token, schema, operation, or table**, instead of a type supplied by the consumer at the point of retrieval. Preserve NestJS module/service/controller ergonomics; stop preserving NestJS signatures that assert facts the framework cannot know. Keep Hono's own client and HTTP types.

## Highest-priority changes

### 1. Couple endpoint schemas to implementations before generating client contracts — M1, M3, M6

**Locations:** `vela/src/http/decorators.ts:83`, `vela/src/openapi/decorators.ts:92`, `vela/src/live/live.decorators.ts:38`, `vela/src/live/live.types.ts:24`.

HTTP and live decorators return the unrestricted legacy `MethodDecorator`. `ApiResponse` can describe a different response from the handler; `LiveQuery<A>` checks the parser/tag callbacks against `A`, but never checks the decorated method against it. Live input parsing is optional, and live metadata has no response schema. Runtime reflection cannot recover erased TypeScript method types. Generating a precise `hc` or live contract from unchecked metadata produces precise types for an unverified claim.

**Recommendation:** Introduce one schema-bearing operation/query declaration, with input, output, status, and name/path information. Bind implementations through a typed function or typed method decorator that checks the descriptor. The declaration must feed validation, route registration, OpenAPI, Studio, and codegen. Keep DI and class decorators; parameter decorators alone cannot guarantee that a parameter annotation matches its runtime value. Separate schema input from parsed output when transforms/coercion are allowed. Codegen validation can reject malformed documents, but cannot independently prove handler conformity.

**Acceptance:** Negative type fixtures reject a handler returning the wrong output or accepting the wrong parsed input. Runtime tests reject invalid inbound data and detect invalid declared responses. The same declaration drives HTTP/client/live metadata.

### 2. Make request/context/entrypoint retrieval evidence-based — M1, H2

**Locations:** `vela/src/pipeline/types.ts:11–48`, `vela/src/http/execution-context.ts:25–39`, `vela/src/http/request-context.ts:15–16`, `vela/src/entrypoint/entrypoint.registry.ts:114`, `vela/src/cache/cache.types.ts:28–43`, `vela/src/dispatch/internal-dispatcher.ts:171`.

`getType<T>()`, `getRequest<T>()`, `getContext<T>()`, `getContainer<T>()`, request-bag `get<T>(string)`, entrypoint `ofKind<M>(string)`, cache `get<T>(string)`, and dispatcher `run<T>()` let callers invent a result type. The implementations mostly assert that type; a default of `unknown` does not close the hole. `getType<'queue'>()` currently compiles for an HTTP context.

**Recommendation:** Return concrete `Request`, Hono `Context`, `Container`, and transport discriminants. Use a transport-discriminated execution context when different hosts expose different values. Bind metadata to `EntrypointKind<M>` handles, and request-local values to identity-based typed keys. Cache/network reads should return `unknown` or accept a decoder whose output is inferred. Internal HTTP dispatch should return a `Response` or use the same generated operation contract as Hono RPC. Do not add another arbitrary `getValidated<T>()` without a validator argument.

**In progress:** Cloudflare's `get<Value>(token: Token<Value>)` wrapper already replaced its independently chosen result type during this audit. `EnvService.get<T>(string)` remained present at inspection; the Cloudflare lane owns replacement.

### 3. Check DI registration as well as resolution — M1, M3, M6

**Locations:** `vela/src/container/types.ts:14–20`, `:34`, `:88–101`; `vela/src/registry/types.ts:129–132`; `vela/src/container/container.ts:205`.

`Token<T>` includes untyped `string | symbol`, permitting `resolve<Date>('counter')`. Module provider arrays erase `ProviderOptions<T>` to its `unknown` default, so `{ provide: InjectionToken<Counter>, useValue: 'wrong' }` compiles. Provider options also permit competing strategies together and do not connect the `inject` tuple with factory parameters. Merely fixing `get` leaves registration unsound.

**Recommendation:** Require class or typed-token handles for typed resolution; raw string/symbol lookup, if retained, returns `unknown`. Use provider constructors that infer the value from the supplied token, prevent competing inference with `NoInfer`, and return validated provider registrations. Represent value/class/factory/alias registration as a discriminated union. Reuse the existing `InferTokens` plus `const` tuple pattern from async module authoring for factories. Apply the same token/value coupling to `setRequestInstance`.

**Acceptance:** Wrong value/factory/alias types under a token and simultaneous provider strategies fail compilation. Heterogeneous storage remains an internal concern, not a reason to expose unchecked retrieval generics.

### 4. Carry real live contracts into clients and React hooks — M1, M3, M6

**Locations:** `client/packages/client/src/types.ts:1–19`, `:111–153`; `client/packages/client/src/live-client.ts:172`, `:250`, `:321`; `client/packages/react/src/context.ts:9–28`; `client/packages/react/src/use-live-mutation.ts:27`.

`LiveClient<C>` receives no runtime contract; `mutate<R>(path, body)` parses JSON and asserts `R`. React stores `LiveClient<any>` and lets each `useLiveClient<C>()` choose an unrelated contract. Optimistic targets and hydration entries are not tied to query names/results. Additionally, the documented named `interface AppLive` fails `C extends LiveContract`: its string index signature is missing.

**Recommendation:** Construct the client from the shared live contract/decoders and infer query arguments/results from that value. Create React bindings once from that typed client or contract, keeping the provider/hooks in the same generic closure. Mutations should consume typed Hono operations or an operation descriptor/decoder, not an unconstrained response generic. Preserve query/result relationships in optimistic updates and hydration. Replace the open-index-signature constraint with a shape check over the declared keys. Validate live payloads against the query schema at the appropriate network boundary; frame validation alone only proves the protocol envelope.

**Acceptance:** A hook cannot choose an independent contract, invalid query names/args/optimistic values fail compilation, and an interface with declared query keys works. Network payloads cannot enter typed subscription state solely via an assertion.

### 5. Preserve the model → table/adapter → resource → response relationship — M1, M2, M3, M6

**Locations:** `crud/packages/drizzle/src/adapter.ts:74–96`, `:145`; `crud/packages/drizzle/src/database.ts:14–35`; `crud/packages/core/src/kernel/resource.ts:37–40`, `:100–107`, `:132`; `crud/packages/core/src/model/model.types.ts:326`; `crud/packages/core/src/model/serialization-profile.ts:20`; `crud/packages/core/src/model/managed-fields.ts:57`.

`drizzleAdapter<R>(config)` takes `db: unknown` and an untyped table, so `R` is unrelated to either. `defineModel` initially retains its schema, but `ResourceConfig<Row>.model: Model` erases that relationship and `execute()` always returns an erased `EngineResult`. Public field lists are `string[]`. `applyProfile<T>(): T` and `stripPrimaryKeys<T>(): T` promise properties that they explicitly remove.

**Recommendation:** Infer the adapter row from the concrete Drizzle table (or require a schema decoder for a deliberately erased adapter); use concrete dialect-specific driver surfaces rather than a hand-written all-`any` query builder. Bind resource generics to the model schema and compatible adapter. Infer field options from schema keys and preserve literal exclusions when response types need them. Separate stored row, create input, update input, and public output. Return `Omit<Row, ExcludedKeys>` for known exclusions; return an honestly weaker record for dynamic policy-driven shaping. Do not label redacted/partial rows as the full storage row.

**Acceptance:** Wrong adapters, unknown field names, and access to excluded response fields fail compilation. D1 capability work should proceed independently of this type redesign; changing the transaction surface does not by itself fix the unrelated `R`.

### 6. DTO construction must fulfill the schema output it promises — M1, L2

**Location:** `vela/src/validation/create-zod-dto.ts:12–36`.

The returned constructor is asserted to produce `ReturnType<schema.parse>`, but accepts no argument and then initializes no fields. `new UserDto().name` has type `string` while the property is absent. Non-object schemas are also accepted, despite returning a constructed object.

**Recommendation:** Prefer the operation schema directly and remove the DTO facade if it adds no necessary capability. If the NestJS class facade stays, distinguish the metadata holder from parsed instances: provide a parser/factory that returns validated schema output, or require and validate input before producing an instance. Restrict class-style DTOs to object schemas. Give the exported factory an explicit public return contract after resolving the mismatch; merely writing its current asserted constructor type more explicitly does not fix it.

### 7. Retain provider-specific auth types through a real configured token — M1, L2

**Locations:** `auth/src/better-auth.types.ts:3–8`, `:25–29`; `auth/src/better-auth.service.ts:33–55`.

`Auth<any>` erases plugin/custom-user inference and the universal `BetterAuthService.api` exposes that erased surface. The comment explicitly recommends consumers cast richer user/session shapes. Replacing the alias with a generic service that callers can instantiate with arbitrary `T` would repeat the problem.

**Recommendation:** The framework should consume only the narrow handler/session capabilities it needs. Export a configuration-bound typed token for the concrete auth instance, inferred from `typeof auth`; application code resolves that token to keep provider/plugin inference. Keep the canonical verified authorization identity small and separate from provider data. The auth lane is already consolidating that identity; this finding concerns preserved provider API types, not a separate identity design.

## Secondary simplifications

### 8. Remove mutable generic builder aliasing — M7

**Location:** `vela/src/module/configurable-module.builder.ts:58–105`.

The fluent builder mutates `this` and casts it to a new generic state. An earlier alias retains its old type after `setClassMethodName('register')` changes the shared object, so a subsequent `build()` can claim `forRoot` exists while creating `register` instead. This is actual state/type divergence, not a request for more advanced builder types.

**Recommendation:** Use the existing one-shot `defineModule` object API as the canonical authoring surface and remove the compatibility builder, or make transitions return new immutable builder instances. Add a regression for retained aliases if the builder remains.

**Implemented:** The builder now creates immutable, concretely typed branches and delegates to `defineModule` without double assertions. Original and renamed aliases, factory-method names and extras transformations have runtime regressions; explicit constructor state generics and invalid retained-alias method calls have source and emitted-package negative checks. Core focused follow-up: 7 files / 115 tests passed; root coordinates final declaration/build verification.

### 9. Typed local state references need unique runtime identity — M1, H2

**Locations:** `client/packages/client/src/client-query.ts:11–24`; `client/packages/client/src/types.ts:263`.

`createClientQuery('x', 0)` and `createClientQuery('x', '')` are separately typed handles that alias the same string-keyed store entry. The current `get<T>` assertion then returns a value with the wrong type even though every consumer call typechecks.

**Recommendation:** Key the store by the reference object or an opaque identity generated with it. Keep a human-readable name only for diagnostics. A branded string that callers can independently recreate with different types would not solve the collision.

### 10. Derive shared types without rebuilding Hono — H4, M2, M4, M5, L2

**Locations:** `client/packages/client/src/http.ts:1–17`; `vela/src/registry/types.ts:54–75`; `vela/src/http/types.ts:5–39`; `vela/src/http/route-map.ts:25–42`; `vela/src/http/response-mapper.ts:33–42`; `vela/src/constants.ts:26–55`; `live-protocol/src/frames.ts:43–55`.

The `hc`/client response/request/status exports already come directly from Hono: retain this. The current framework route build returns a plain Hono app; do not pretend runtime decorator registration preserves Hono's route inference. Use a generated, verified Hono schema contract or a declaration that truly accumulates static routes. A `Hono` type assertion is not an inference solution.

Consolidate duplicated `RouteMetadata`/`RouteDefinition` and `ParamMetadata`/`ParameterMetadata`; one version currently narrows methods while the other uses `string`. Keep Hono status types in status-aware public APIs and validate dynamic numeric statuses before response mapping. Derive named route parameters from the same operation/path declaration instead of maintaining an independent `VelaRouteMap`; reuse Hono's path semantics rather than inventing a second route parser. Existing `as const` maps in constants and protocol error codes already follow H4 well. Preserve useful inferred return types at builder/generator boundaries; blanket annotations to broad interfaces would lose inference.

## Verification and implementation order

Using the installed TypeScript 6.0.3 compiler with strict/noEmit and virtual source files importing the real declarations, six invalid examples produced **zero diagnostics**: mismatched token/provider value; HTTP request as `Date`; HTTP transport as `'queue'`; string bag read after numeric write; empty DTO with required typed property; and a string token resolved as `Date`. A separate fixture reproduced **TS2344** for the documented `interface AppLive` under `LiveContract`. No source, dependency, or test files were modified for these checks. No estimated type-coverage percentage is claimed.

Suggested integration order:

1. Core: concrete execution contexts, typed tokens/providers/metadata keys; decide the shared endpoint/query contract with client/live owners.
2. Parallel package work: Cloudflare binding inference, CRUD model/adapter correspondence, auth configured-token inference, and client/React contract propagation.
3. One end-to-end type fixture: a Workers controller using injected D1/auth, an inferred CRUD response, `hc`, and a live query. Invalid inputs/results must fail compilation; valid code must need no consumer casts.

Use brands only for validated values or identity-sensitive keys where interchange creates a real error. They do not prove authorization, and branding every path/id/status would add friction without fixing contract drift. Keep `unknown` at actual external boundaries; narrow or decode before exposing typed values. A remaining internal assertion should have a precise invariant and a targeted test, not a blanket exemption or a new generic helper that hides it.

## Implemented: honest execution contexts

The follow-up implementation removes independently selectable type arguments from the HTTP, WebSocket, and entrypoint execution contexts. `HttpArgumentsHost` returns `Request` and Hono `Context`; `WsArgumentsHost` returns `WsClient`, `unknown` payload, and a string pattern. All execution contexts expose `getContainer(): Container | undefined`. HTTP container lookup checks the actual `Container` instance. Wrong-transport accessors return `never` and throw without type assertions. The base kind remains open to custom adapter strings; HTTP/WS builders preserve their literal kind, and the entrypoint builder infers its kind from the supplied argument. The entrypoint payload remains `unknown` until validated.

Files changed for this implementation: `vela/src/pipeline/types.ts`, `pipeline/index.ts`, `index.ts`, `http/execution-context.ts`, `websocket/ws-execution-context.ts`, `websocket/websocket.types.ts`, `entrypoint/execution-context.ts`, and the necessary cache/signed-URL/signed-invocation/queue callers. Queue dispatch supplies its actual child container. The Workers trace fixture now uses `WeakMap<Request, string[]>` rather than pretending `Request` has custom fields.

New `vela/src/__tests__/execution-context.typecheck.ts` runs under the existing core tsconfig and rejects fabricated `Date` requests, invented execution kinds, caller-selected containers/contexts, and unvalidated WebSocket/entrypoint payloads. New `execution-context-contract.test.ts` verifies real HTTP object identity, framework-container lookup, WebSocket accessors, custom kinds, wrong-transport failures, and guard/interceptor scope propagation.

Validation: direct core `tsc --noEmit -p tsconfig.json` passed. Focused Node suites passed **102 tests across eight files** (context contracts/module metadata, WebSocket, queue, cache, named routes, signed invocation guard/body). Formatting completed. A Workers suite invocation failed during Cloudflare Vitest initialization before any tests ran: `TypeError: Cannot read properties of undefined (reading 'config')` at the suite's `describe()` call. No runner configuration or dependencies were changed in this lane. Existing shared test suites with old accessor type arguments were left for their owners; the Workers fixture was updated because it participates in core typechecking.

The DTO follow-up below adopts schema descriptors instead of the optional, unvalidated `Object.assign` constructor identified by the audit.

## Implemented: request keys and schema descriptors

The next coordinated follow-up replaces typed request-bag assertions with `RequestContextKey<Value>`. `get(key)` infers `Value | undefined`; `set(key, value)` uses `NoInfer<Value>`; raw string/symbol reads return `unknown`. Typed keys own `WeakMap<RequestContext, Value>` storage and use invariant read/write function properties, eliminating retrieval assertions and same-description collisions. i18n now uses a typed locale key. Dedicated runtime tests cover request isolation and collision prevention, and normal core typechecking includes negative tests for wrong values, result overrides, and unsafe token widening/narrowing.

Final variance checks also reject `context.set<unknown>(numberKey, 'bad')`, explicit union widening, and assignment of a number key to `RequestContextKey<unknown>`. Existing arrow-function read/write properties already enforce invariance, so no extra phantom field or runtime logic was needed. Full core typecheck passed after these regressions were added.

`createZodDto` was removed. `defineDto<Value>(schema, { name? })` returns a frozen descriptor with `name`, `schema`, `parse(unknown): Value`, and `toJSONSchema(): unknown`. This directly satisfies the client lane's schema-bearing endpoint shape. JSON-schema generation delegates or fails explicitly when unavailable. There is no generated class or populated-instance assertion. `ValidationPipe` now exposes `readonly parser?: RuntimeParser`, accepts descriptors/direct schemas in explicit metadata, and narrows metadata and parser errors without casts. `ArgumentMetadata.metatype` is honestly `unknown`; the extractor no longer casts it to a constructor.

Core validation, serialization, programmatic-route and parity fixtures plus the Evergreen example were migrated to descriptors and explicit body parsers. The client lane owns OpenAPI fixture migration and descriptor introspection; the CRUD lane owns `stamp-routes`. Usage is documented in `vela/TYPE_CONTRACTS.md`. Dedicated DTO type tests reject constructor calls and fabricated parser outputs. The seven focused descriptor/validation/serialization/programmatic-route/request-context/i18n suites passed **43 tests**. The latest full core typecheck reached only two unrelated concurrent integration errors in `config/register-as.ts` and `module/define-module.ts`; no diagnostics remained in this lane's files.

## Implemented: testing integration

`TestingModule.get<const Key extends Token>(token: Key): InferToken<Key>` now uses the same token inference as the actual container. `OverrideBy<Key>` carries that token into `useValue(value: NoInfer<InferToken<Key>>)`, `useClass(cls: Type<NoInfer<InferToken<Key>>>)`, and a factory whose dependency tuple is inferred from `inject` and whose output must match the token. Every override creates a checked `defineProvider` descriptor. Guard/pipe/interceptor/filter overrides retain their concrete class contracts. The builder no longer reaches a private method through bracket indexing.

`TestingModule.fetch(...args: Parameters<HonoApp['fetch']>): Promise<Response>` preserves Hono's actual arguments with no casts. `runInRequestScope` calls the production `createRequestContext` factory exported through core/internal, seeds the real child container on its Hono context, and supports identity-based request keys without duplicating a fake generic request bag.

`TestResponse.json(): Promise<unknown>` exposes unvalidated bytes honestly; `json<Value>(parser: SchemaParser<Value>): Promise<Value>` validates and infers parsed output. A cached promise handles concurrent reads and `null` bodies while each requested parser operates on the original value. Assertions narrow strings/arrays/objects at runtime. `assertJson` retains exact top-level key behavior, including keys containing dots.

Changed testing source: `testing/src/testing-module.ts`, `testing-module.builder.ts`, and `http/test-response.ts`. Dedicated `testing-types.typecheck.ts` rejects invented resolved/JSON result types, incompatible overrides, and mismatched factory dependency arity/types. Runtime fixtures in `testing-module.test.ts`, `scope-seed-db.test.ts`, `test-response.test.ts`, and `ws-node.test.ts` use the new provider/request/module contracts. The lab consumer example now exports specific provider instance contracts instead of erased `Type`, resolves by inference, and registers checked descriptors; README documents the new API. AI/eval code is untouched.

Validation: testing package typecheck and explicit typecheck of all eight non-eval runtime test files passed. **68 tests across eight suites passed**, including the real Node WebSocket test. Changed-file lint produced no errors (existing style warnings remain). Lab consumer source typecheck passed, and root verified the example typecheck and **four consumer tests** after fixing its workspace link. No installs or manifest edits were made in this lane.

## Implemented: response mapping and final token integration

`vela/src/http/response-mapper.ts` now contains no status or result assertions. `HttpCode`, its reader, and registry metadata use Hono's `StatusCode`; `Redirect`, its reader, and redirect metadata use Hono's `RedirectStatusCode`. JSON results narrow naturally after the null/undefined branch, including primitive JSON values. Explicit null/200 remains an empty 200 response. Statuses 204/205/304 deterministically discard controller body values. Prebuilt `Response` instances pass through unchanged before ordinary status validation, preserving transport-created upgrades. Ordinary responses reject statuses unsupported by Fetch; 101 requires a prebuilt upgrade response. Dynamic redirect handler results validate their URL/status shape; statuses must be integers in Hono's 300–308 redirect set, with invalid values rejected explicitly.

Added `response-mapper-contract.test.ts` and `response-mapper.typecheck.ts`: default/explicit empty responses, JSON primitives, prepared headers, bodyless statuses, passthrough responses, invalid native statuses, dynamic redirect overrides and invalid metadata are covered. Core typecheck passed and **324 tests across four suites** passed (mapper contract, NestJS parity, endpoints, and middleware exception filters).

The final core token split required no remaining generic `Token<T>` migrations in testing or feature flags. Testing overrides now preserve `defineProvider`'s authoring-token proof via its actual parameter type, rather than treating erased registry identities as authorization to replace typed values. Factory dependency tuples use `DependencyToken` (including forward refs), and `inject` is mandatory; zero-dependency factories supply `[]`. Compile regressions cover erased/explicitly widened token overrides and explicit dependency tuples without supplied tokens. Feature flags source and all test files typecheck, with **39 tests across six suites** passing.

The cross-package negative regressions exposed a declaration-emission issue in the first invariant-token build: `private readonly valueType: (value: T) => T` emitted as `private readonly valueType;`, dropping invariance for package consumers. The core owner fixed it with a protected invariant member whose `(value: T) => T` annotation survives declaration emission. Against the corrected built package, all testing negative fixtures, testing source and runtime-test typechecks, feature-flags source and runtime-test typechecks, lab source and consumer-test typechecks, and full core typecheck pass. Final runtime rechecks passed **68 testing tests**, **39 feature-flag tests**, and **four lab consumer tests**. No remaining work is blocked in this lane.
