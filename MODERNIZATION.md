# Vela API modernization

Implemented and verified 2026-09-20. Coordinator: **Modernize Lunora NestJS stack**
(`01a0bd26-bb88-7c32-ab01-c2b142c5ee1b`).

## Product and architecture

Build the NestJS authoring experience on Cloudflare Workers, with an integrated
Studio and live subscriptions. Controllers, modules, dependency injection,
guards, and interceptors remain useful product features. Every public signature
may change. There is no compatibility requirement or deprecated implementation
path to preserve. AI, agents, workflow, and email are outside this work.

The application has six cooperating parts:

1. **Modules define the graph.** Checked provider descriptors bind a token to its
   implementation and dependencies. Resolving a token infers its value type;
   callers cannot select an unrelated result type. Imports and exports enforce
   actual module visibility, including factory dependencies.
2. **The platform builds the graph.** Native typed Workers bindings are supplied
   before providers or lifecycle hooks run. Bootstrap is shared per environment
   identity, failures can retry, and distinct environments never share live
   drivers or other mutable application resources.
3. **Schemas define contracts.** Request parsing, response validation, OpenAPI,
   and generated HTTP client types use the same endpoint definition. Decorators
   cannot recover erased TypeScript types. Unknown data stays unknown until a
   parser validates it; a caller-selected generic is not validation.
4. **Hono handles HTTP.** Vela supplies the Nest-style authoring and execution
   pipeline. The HTTP client is upstream `hono/client`, preserving its Fetch
   responses, headers, cookies, and options. No second HTTP RPC protocol.
5. **Live handles subscriptions.** One shared protocol defines frames, row
   operations, reconnect behavior, and cursor bytes. Drivers and cursor logs are
   factories scoped to the application. Native Durable Objects are a platform
   implementation, isolated behind a Worker-only entrypoint.
6. **Studio operates the running API.** The host authorizes operations with its
   local session, then try-it sends a real HTTP request to the Worker using only
   the API credentials the user supplied. Studio advertises operations that
   exist; live inspection placeholders are not working features.

CRUD uses a request scope for ordinary operations and requests a transaction
only when correctness needs one. D1 has no callback transaction capability:
unsupported multi-step atomic writes fail before writing. Cursor pagination
uses an ordered field plus a unique primary-key tie-breaker, validated once at
the engine boundary.

Authentication providers publish one verified, immutable request identity.
Authorization consumes that identity, including tenant and expiry boundaries.
Provider-specific payloads do not form a second authorization channel.

## Workspace

The root `pnpm-workspace.yaml` and `pnpm-lock.yaml` coordinate 29 workspace projects: the API packages,
Studio, clients, and Cloudflare examples. Local dependencies use workspace links.
Hono, TypeScript, build tools, Workers runtime tools, and test tools are aligned
through one catalog. `pnpm install` succeeds and peer dependencies have been
checked. Existing nested Git repositories and their unfinished changes remain.
This is a shared development workspace, not a Git-history migration.

Previous per-repository workspace/lock files and temporary validation links are
preserved in ignored `.modernization/previous-workspace-files`. Deferred
Cloudflare workflow/email source is preserved in ignored
`.modernization/deferred-cloudflare`; it is absent from the active API build.

Root verification commands:

- `pnpm build`: dependency-ordered package builds.
- `pnpm typecheck`: package source and declared type regression checks.
- `pnpm test`: package runtime suites.
- `pnpm test:conformance`: CRUD cross-adapter and real D1 suites.
- `pnpm test:workers`: real Workers suites.
- `pnpm verify`: all of the above, in order.

No code has been committed, published, or deployed by this coordinator.

## Parallel implementation tracker

| Task | Ownership | Current state |
| --- | --- | --- |
| **Vela Cloudflare typed runtime modernization** (`01a0bd3b-6bd9-7c80-9fde-6008e96c8322`) | Native Env/bootstrap, platform drivers, cache boundary, examples | Complete; native bindings, early configuration, per-environment lifetime, cache parsers, and real Workers tests. |
| **Vela CRUD typed cursors and D1** (`01a0bd3b-6e5c-7432-8b5b-dfe0ad27b2e2`) | CRUD core, memory/Drizzle adapters, cursor/D1 conformance | Complete; schema-bound resources, honest hook outputs, compound cursors, explicit capabilities, and real D1 conformance. |
| **Vela shared typed authentication identity** (`01a0bd3b-70ca-73c1-bf72-048690918a3e`) | Better Auth, Access, authz, core identity | Complete; shared immutable identity and provider-independent guards. |
| **Review Hono RPC guide** (`01a0bd11-6331-7133-987b-dbfced9b468c`) | Client, CLI, OpenAPI/endpoint schema definition | Complete; upstream hc, checked codegen, shared HTTP/live schemas, parser-backed mutations, isolated React hooks. |
| **Vela Studio Workers development integration** (`01a0bd3c-1147-7232-a03e-99251dcd65f4`) | Studio protocol/server/host/UI | Complete; actual Worker HTTP try-it, separate credentials, schema-validated operations and honest capabilities. |
| `core_type_holes` subagent | Core DI/bootstrap/factory/entrypoints | Complete; checked providers, inferred resolution, async construction, parsed metadata and immutable module builders. |
| `generic_architecture_audit` subagent | Contexts, DTOs, testing, response mapping, authoring guidance | Complete; concrete contexts, typed request keys, schema descriptors, typed test overrides, updated bundled skill. |
| `live_protocol_types` subagent | Protocol, live lifecycle, feature flags, lazy decorators | Complete; shared query parsers, isolated resources, validated persistence, parser-backed flags and explicit lazy loaders. |
| Coordinator | Workspace, HTTP execution, Hono request scope, integration | Complete; frozen install, builds, source/emitted-package types and 3,307 runtime tests pass. |

Each lane keeps evidence and remaining limits in `.modernization/reports/`.
Historical audit tasks are retained there; the implementation state above
supersedes the initial audit and first-tranche test results.

## Acceptance

- [x] Reproducible root install using local packages; align Hono and Workers tools.
- [x] Native platform environment available before provider initialization.
- [x] Environment-specific bootstrap and per-application live resources.
- [x] Typed token resolution; raw tokens cannot fabricate arbitrary results.
- [x] Checked provider descriptors required at public registration boundaries.
- [x] One shared authenticated identity and provider-independent authorization.
- [x] Exhaustive live protocol validation without production non-const assertions.
- [x] One endpoint schema validated at HTTP ingress/egress and consumed by OpenAPI/RPC.
- [x] Parser/key evidence replaces fabricated cache, flag, context, DTO and mutation types.
- [x] Compound cursor and real D1 conformance verified after integration.
- [x] Studio try-it crosses an actual Worker HTTP boundary without host credentials.
- [x] Full root build/typecheck/runtime/Workers suites pass together (`pnpm verify`).
- [x] Updated public API snapshot, migration docs, examples and bundled authoring skill.
- [x] Raw Hono variables remain unknown; framework request state uses private storage.
- [x] Entrypoint metadata parsing, immutable builder branches and explicit lazy loaders.

See [the integration evidence](.modernization/reports/integration.md) and the
[complete verification log](.modernization/final-verify.log). The final run has
3,307 passing tests across 30 runtime suite invocations; no failing suite or
TypeScript diagnostic. Frozen installation and peer checks also pass.

## Explicit limits

These changes strengthen the authoring contracts and validate external data;
they do not establish that every historical internal assertion has been removed.
Decorator reflection cannot recover erased interfaces or prove arbitrary method
parameter annotations. Use checked factory tuples, Endpoint contracts and shared
live definitions where static correspondence matters. Heterogeneous DI storage
and the Drizzle fluent-builder adapter retain documented internal correlation
boundaries. Deliberately widened structural class tokens also remain a TypeScript
limitation; invariant InjectionToken handles are the stronger binding API.

D1 cannot implement JavaScript callback transactions; operations that need them
fail before effects. MySQL was not exercised against a real server. Studio live
room/subscription inspection was initially unavailable. The release follow-up
adds explicit inspection sources and verifies them in the complete Workers starter. Live subscriptions themselves run through the tested shared
protocol. No publication, production deployment or cloud-account smoke test was
performed. Deferred packages and examples outside the selected workspace were
not migrated to the breaking APIs.

## References

- [Hono RPC](https://hono.dev/docs/guides/rpc)
- [Hono application composition](https://hono.dev/docs/guides/best-practices)
- [Cloudflare bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/)
- [Workers Vitest plugin migration](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/)
- Local Lunora reference: `references/lunora/README.md` and Vite/Studio code.

## Release follow-up

The complete starter, Studio live inspection, 2.0 package versions, tarball
verification, and local/staging smoke results are documented in [RELEASING.md](RELEASING.md).
