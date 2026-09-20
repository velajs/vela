# Client and contract implementation

Implemented in the shared checkout without commits, publication, compatibility layers, or dependency edits by this lane. Coordinator owns manifests, installation, core exports/runtime outside OpenAPI, and protocol descriptors. Existing user changes were preserved.

## Result

- HTTP uses Hono's actual `hc`, response helpers, and types through the opt-in `@velajs/client/http` entry. The live entry does not import Hono at runtime.
- `vela client generate` creates a deterministic type-only `AppType` and component `Schemas` from the application or an OpenAPI file. `--strict` rejects unknown-schema diagnostics; `--check` verifies freshness without writing. Runtime app disposal is guaranteed after generation failures.
- Imported JSON remains `unknown` until decoded. A Zod 4 projection validates every consumed nested field, scalar/boolean schemas, operations, request/response media, parameters, refs, and extensions. Cycles/depth are checked. This projection intentionally does not claim to validate every OpenAPI feature.
- GET/POST/PUT/PATCH/DELETE/OPTIONS/HEAD, JSON body, JSON/text responses, literal/range/default statuses, wire params/query/header values, recursive components, arrays, unions/intersections, nullable values and scalar enums remain supported. Unsupported serialization, media, refs, path shapes and direction-dependent schema keywords fail explicitly. Missing schemas produce `unknown`, never invented response types.
- Core OpenAPI uses checked JSON Schema conversion and decoded decorator metadata. Explicit `ValidationPipe.parser` descriptors are discoverable; fake DTO constructors are gone from owned tests/docs. Prefixes, versions, explicit statuses and whole-query object fields are preserved.
- `defineEndpoint({input,output,status,format})` plus `@Endpoint(definition)` correlates method types, exported schemas and runtime parsers. Main exports/dispatcher integration were coordinated and implemented by root. One parsed input object has param/query/header/json groups; input and final interceptor output validation use the same definition. The method decorator and `.bind()` reject incompatible handler input/output at compile time.
- Shared `defineLiveQuery({args,result})` comes from `@velajs/live-protocol` with no schema-library dependency. The same descriptor now feeds the server live decorator and client query map in the cross-package integration suite.
- `createLiveClient({queries,...})` infers names/args/results from parser evidence. `LiveClientOptions<C>.queries` is required even when callers explicitly name C. Typed subscriptions parse args before registration. Snapshots and merged deltas are checked before changing authoritative base, cursor, epoch, or optimistic gates. Invalid data reports `LIVE_SCHEMA_INVALID` and retains the last valid base/watermark. Hydration and cross-tab snapshots use the same reducer. Optimistic values validate before publication. Parsed values are memoized per query/args/room and raw identity so React snapshots stay stable with cloning parsers.
- `subscribeRaw`/`peekRaw` explicitly return unknown for dynamic tooling. Presence uses raw transport plus a concrete roster decoder. Browser WebSocket uses an actual structural adapter instead of `as never`.
- Mutations without result evidence return `Promise<unknown>`; `{parseResult}` infers sync/async results. Parsing occurs after commit/transport handling, so parser rejection cannot replay an already committed write.
- React exports `createLiveHooks<C>()`, returning one typed provider and hook family. No global `LiveClient<any>` context or caller-selected context generic. Native uses the same hooks and infers its client contract from the required schema map.
- Local client queries use typed reference-owned cells per client instance. Same-label references are distinct, preventing a string-key collision from making a read claim another type. Function-valued ref methods make references invariant; explicit generic widening is rejected.

## API migrations

```ts
// Portable contract module shared by Worker and frontend.
import { defineLiveQuery } from '@velajs/live-protocol';
import { z } from 'zod';
export const todo = z.object({ id: z.string(), text: z.string() });
export const todoList = defineLiveQuery({
  args: z.object({ listId: z.string() }),
  result: z.array(todo),
});
export const queries = { 'todos.list': todoList };
```

```ts
// Server: @LiveQuery('todos.list', todoList, { tags: ['todos'] })
// Client:
const client = createLiveClient({ url, queries });
const { LiveProvider, useLiveQuery, useLiveMutation } =
  createLiveHooks<InferLiveContract<typeof queries>>();
const created = await client.mutate('/todos', body, {
  parseResult: (value) => todo.parse(value),
});
```

Create hook factories once at module scope. Reuse the returned provider and hooks as a family. Native callers pass `queries` too. Raw mutation generics (`mutate<Result>`) require the matching parser; no-parser calls remain unknown. Export and reuse the same `createClientQuery` reference to share local state; its string is only a label.

For ordinary parameter decorators use `defineDto(schema,{name})` and `@Body(new ValidationPipe(dto)) body: ReturnType<typeof dto.parse>`. Prefer `@Endpoint` for shared HTTP input/output validation. Documentation-only `@ApiResponse` does not validate the runtime handler result. Endpoint methods cannot also declare parameter decorators, HttpCode, or Redirect.

## Owned files

- CLI: new `src/client-contract.ts`, `client-contract-input.ts`, their decoder/compiler/runtime suites, `commands/client.command.ts` and suite; existing CLI wiring/docs from prior hc work; raw provider fixtures migrated in introspection/MCP tests. Studio optional-peer test now deterministically suppresses that peer in a child loader rather than hanging when it resolves from the workspace.
- Client: HTTP entry/tests; live-client/types/exports; subscription reducer validation and connection invalid-frame handling; presence decoder; local client-query cells; mutation-result, live-schema, browser socket, and negative type tests; existing integration/cross-tab/offline/native fixtures migrated to schema evidence.
- React: context factory, hook factories, exports, runtime and negative contract tests. Native: generic options/factory inference and schema-aware fixtures.
- Core: only `src/openapi/*` and associated OpenAPI tests. New endpoint definition/typecheck, JSON Schema decoder and boundary suites. Root owns main exports, dispatcher and its additional runtime tests.
- Docs: `client/HTTP.md`, client README, Native README, CLI README. Prior hc changesets retained. No MODERNIZATION.md edits.

## Verification

Initial baseline typechecks passed before implementation. Final checks use installed workspace binaries, without lane installs:

- CLI: TypeScript check, build, full 58-test suite. Includes generated-contract compiler negative tests against the actual installed `@velajs/client/http` (no ambient adapter shim), status narrowing and missing/wrong route/body/query calls.
- HTTP runtime conformance: generate from actual Vela Endpoint metadata, compile an hc consumer, then execute GET with headers/repeated query values and POST JSON with status201 through Vela's app fetch.
- Core: source TypeScript check including `src/openapi/endpoint.typecheck.ts`, and 70 OpenAPI tests. Root also owns/passes HTTP pipeline tests for guard order, malformed JSON400, interceptor output500, string/null JSON, text and competing metadata.
- Client: TypeScript check, build and full suite, including shared descriptor server/client integration, live row/parser rejection, stable snapshots, mutation parser replay safety and local reference type safety.
- React: TypeScript check/build and 9 tests, including parser-backed mutation results, context isolation, wrong-provider/query/argument negative checks.
- Native: TypeScript check/build and 20 tests.

Final lane results: CLI 58/58 (after Zod4 catalog install and final core declarations), core OpenAPI 70/70 plus source typecheck, client 89/89 plus build/typecheck, React 9/9 plus build/typecheck, Native 20/20 plus build/typecheck. A final typed-optimism rollback fix was then added at 03:03 UTC-3: the empty cache sentinel bypasses result validation when no base/layers remain. Its full 4-test live-schema suite and client source typecheck passed; expected complete client count is now 90. No dist rebuild after that source fix, per coordinator's workspace-build lock. Root should include that last source change in its coordinated build/check.

CLI runtime conformance briefly failed when run concurrently with client tsdown cleaning its dist; rerunning after the dependency build completed passed all58. This was a verification ordering race, not a contract change.

## Boundaries and remaining limits

- Generated HTTP types describe declared schemas. Runtime evidence is supplied by Endpoint or explicit validation; arbitrary external OpenAPI does not prove the implementation. JSON Schema cannot encode every refinement; runtime parsers remain authoritative.
- There is no live codegen emitter yet. It is not needed for type safety: import the portable query descriptor module into both server and client. Keep that module free of server runtime imports. Shared result parsers should describe JSON wire data and preserve protocol key meaning.
- Invalid live frames retain the last valid cache and report an error; consumers should surface `onError`. The client does not claim invalid rows are typed. Dynamic raw subscriptions intentionally retain unknown.
- `createLiveClient` and Native factory use a public overload to project the exact parser map into `InferLiveContract`; TypeScript cannot reverse-infer the nested mapped outputs through the class constructor. The implementation retains dynamic unknown dispatch and executes that same map. There is no cast or fabricated type guard at this seam.
- OpenAPI decorators still use the central reflection registry, but all retrieved fields consumed by this lane are decoded; no metadata assertions remain in the changed OpenAPI pipeline. General reflection elsewhere in core is root-owned.
- No unsafe assertions remain in the changed live-client, React context/hooks, presence, local client-query or HTTP/schema-generation boundaries. Preexisting assertions remain in unrelated client internals/test harnesses; this report does not claim a package-wide zero-assertion audit.
- Standard JSON-schema support remains deliberately bounded; unsupported tuples/dynamic refs/conditional schemas/readOnly-writeOnly serialization require separate supported schemas rather than guessed types.
