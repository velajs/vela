# Studio modernization implementation

## Result

Studio now bootstraps automatically through a local host session and executes API
Explorer requests through actual Worker HTTP. The Worker still owns authorization,
write gates, and an authorization audit record. Custom UI/admin mounts, path/query/header
inputs, native Worker bindings/context, and separate browser/admin/API credentials are
covered by regressions. No commits, deployments, publications, or additional agents/tasks
were created. All edits are in Studio source/tests/docs/changesets and this report.
Manifests/workspace/lock changes visible in Studio were performed by the coordinator.

## API changes

- Protocol v2. `StudioConnection` replaces separate `__VELA_*` globals with
  `window.__VELA_STUDIO__`. `parseStudioConnection` validates unknown bootstrap data.
- Host `editable` removed. Read-only sessions receive a fresh host session credential.
  All proxied admin requests require this credential, including health. Reload after
  restarting the host. The HTML is `no-store` and never contains the master token.
- `api.tryit` removed. `api.authorizeTryIt` validates/authorizes/audits method/path;
  `{adminPath}/api-request` performs a separate request to configured Worker origin.
  This never re-enters Hono outside native Worker request context.
- `AdminClient.tryIt` exists only when given a local `apiRequestPath`. UI execution
  additionally requires the operation and `opsEditable`. Direct embeds browse OpenAPI.
- API request/response JSON is validated. Explicit user API authorization/cookies are
  forwarded, while browser cookies/session and master admin token are isolated.
  Set-Cookie is captured as response data; redirects are returned without following.
- All 46 RPC operation results now have concrete Zod validators in
  `STUDIO_RESPONSE_PARSERS`, constrained by the operation-to-result map. The public
  parsers infer output only from the operation. `AdminClient` validates envelopes,
  nested result fields, operation identity, metadata and HTTP/error status agreement;
  the old generic result assertion is removed. Fixtures and the demo use the same
  parsers. Dynamic row records and OpenAPI documents retain their declared unknown data.
- `StudioCapabilities.operations` advertises usable operations. Raw scheduler/websocket
  tokens do not imply Studio handlers. Live/presence enumeration and queue depth/DLQ/
  replay remain unimplemented and are no longer advertised. Unknown queue depth is `—`.
- CRUD reads and individual writes use `requestScope`. Bulk operations explicitly require
  `transactions`, and model descriptors expose `supports.bulkWrites` to disable unsupported
  UI actions. Existing transaction-dependent features remain available on capable adapters.
- CRUD integration uses the explicit `adapter.runtime` data plane without a result cast.
  Handwritten test adapters use `bindAdapter`. The demo's memory adapter now serializes
  scopes and rolls back failed multi-table transactions, retaining its bulk-write demo
  with an actual rollback guarantee. New rollback/concurrent-read regressions pass.
- Studio providers use `defineProvider`; `AdminOpContext.get` infers from tokens.
  Portable/CF time-travel modules accept explicit `imports` for the configured Studio
  signer/model source modules, preserving strict module visibility. Demo updated.
- Studio config uses `registerAs('studio', CONFIG_ENV, factory)` and validates string
  values from the environment record. Feature flags use the new object parser API.
- Direct token login now verifies authenticated capabilities after health; invalid tokens
  are not persisted. Local session credentials never enter session storage.

## Validation

Baseline before edits: Studio Git source tree clean. Existing shared installed compiler:
protocol, host, server source checks passed; UI dependencies were missing. Coordinator
then installed the unified workspace including Studio dependencies.

Latest completed checks:

| Check | Result |
| --- | --- |
| Protocol typecheck and tests | Pass: 4 files, 73 tests |
| Host typecheck and tests | Pass: 8 files, 49 tests |
| Real Worker HTTP | Pass: Miniflare 5/Workerd native KV and waitUntil, real host socket, custom mounts, cookies/auth isolation, redirect handling |
| UI typecheck and tests | Pass: 14 files, 117 tests |
| UI library + standalone build | Pass |
| Fixtures typecheck/tests/build | Pass: 3 files, 12 tests |
| Server suite | Pass: 11 files, 179 tests |
| Server source/test typecheck | Both pass against refreshed config/provider and CRUD runtime declarations |
| Host/protocol builds | Pass |
| Server and demo builds | Pass |
| Demo typecheck and tests | Pass: 2 files, 4 tests, including full operation walkthrough and transaction rollback |
| Formatting/diff whitespace | Pass |
| Targeted lint | No errors; fixture/loop warnings, no newly added unsafe result assertions |

Total: 434 passing tests across 42 files. This includes real Workerd HTTP and the
full Node demo walkthrough. After the final coordinator core build, server source
and test typechecks, all 179 server tests, demo typecheck and all four demo tests
passed again; server/demo declarations were rebuilt. Compile-only regressions prove
generated `StudioModule.forRootAsync` rejects missing `inject`, including a caller
that explicitly supplies a dependency tuple type without supplying runtime tokens.
Zero-dependency Studio async factories declare `inject: []`.

Re-run package checks from each Studio package using `../../../node_modules/.bin/tsc
--noEmit`, `../../../node_modules/.bin/vitest run`, and `../../../node_modules/.bin/tsdown`.
Server also uses `tsc --noEmit -p tsconfig.test.json`. Build protocol before dependent
packages; do not clean/rebuild its dist concurrently with consumers' tests. Host Worker
integration requires prebuilt standalone UI assets. No Workerd binary override needed.

## Changed areas

- protocol: connection, HTTP and all-operation RPC validators; version/operation/capability/model contracts;
  boundary tests and README.
- host: session bootstrap/validation, HTML config, cookie-isolated admin proxy, actual HTTP
  executor; unit/socket/real Worker tests and README.
- server: authorization-only API op, honest capability detection, request-scoped CRUD,
  typed providers/config/flag/auth integration, explicit optional module imports; regressions.
- UI: standalone connection, local API client, login verification, parameter form,
  unsupported operation/bulk-action gating; React regressions and README.
- fixtures/demo: checked protocol results, strict DI migrations and actual memory rollback.
- changeset: `studio/.changeset/worker-http-studio.md` (all four public packages minor).

## Limits and remaining legacy boundaries

Studio's live subscription/room inspection handlers remain explicit
FEATURE_UNCONFIGURED, so their features and operation capabilities remain disabled.
This change does not create a second live protocol or expand time travel.

The Worker audit records authorization of the HTTP request, not completion/status of
its separate host-originated HTTP execution. Explorer displays the actual response.
Time-travel/bulk restore with nontransactional sources remains unsupported; this work
preserves existing behavior on transaction-capable sources and rejects unsupported bulk
mutation rather than pretending D1 callback transactions exist.

New connection/try-it boundaries introduce no unsafe `any`, casts, double assertions,
or dishonest type guards. Removed the old double-asserted live invalidation DI token,
feature record casts, changed OpenAPI read-model cast, and unnecessary CRUD row casts.
The generic AdminClient RPC unwrap assertion and fake-transport result assertions are
removed. Existing reflective CRUD/auth internals and old test fixtures still contain
assertions. They were not expanded or used to silence integration errors.
