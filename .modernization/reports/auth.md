# Auth / Authz / Cloudflare Access implementation report

Date: 2026-09-20. Lane task: `01a0bd3b-70ca-73c1-bf72-048690918a3e`.

## Outcome

One core trusted request identity now drives both authentication integrations, shared authorization, core throttling, and the Cloudflare lane's WebSocket upgrade reader. HTTP authority no longer flows through compatibility symbols, Hono `userId`, or a provider-private request authentication map. The existing Authz `forRootAsync` resolved-options fix is preserved.

Core `TrustedRequestIdentity` keeps the verified issuer/subject/principal type and optional tenant, and adds readonly roles, verified JSON claims, and exclusive credential expiry. Publication validates own data properties, takes frozen defensive snapshots (including nested claims), and clears old state before validation. Readers delete expired state. Provider user/session and Access enrichment payloads are keyed to the exact canonical identity object: clearing, replacement or expiry makes them inaccessible, without creating another authorization source.

`@velajs/authz/vela` owns the single PermissionGuard, RolesGuard, permission/role decorators, CurrentIdentity decorator, and context-to-engine projection. Permission requirements remain AND; role requirements remain OR. The permission guard resolves exactly one engine visible from the declaring module and rechecks identity/expiry after asynchronous decisions. WebSocket frames use only normalized connection issuer/subject/tenant/expiry, never HTTP accessors, frame data or arbitrary socket role metadata. It supports Cloudflare's prototype `data` getter and denies a principal/tenant replacement during a permission decision.

Better Auth validates the complete required base User and Session fields, Date values, matching user/session IDs, future expiry, roles, and active organization before publishing. Plugin fields remain opaque provider payload; authority is copied into core. Auth<any>, boundary assertions, compatibility mirrors and duplicate guards are removed. BetterAuthService preserves a concrete auth instance's generic plugin API when constructed/parameterized with that instance. Runtime configuration is separate from the auth instance, so both sync and async registration satisfy checked provider contracts. The actual signed-cookie helper still creates and authenticates real Better Auth sessions, including logout invalidation.

Access validates all declared JWT claim shapes, including optional registered claims that jose need not inspect, after cryptographic verification. Tenant membership is selected only from signed tenantId or the configured tenantClaim; mapClaims cannot replace authority fields. CurrentAccessIdentity remains a provider-specific payload accessor so mapClaims enrichment is retained, while all permission decisions use core. The jose overload branch is narrowed instead of asserted.

Policy composition preserves context/resource generics. All owned provider registrations use defineProvider. The typed native Workers environment replaces D1 binding wrappers in the D1 example, and the plugin example now has a typed plugin token and correctly returns the auth instance from its factory.

## Verification

Baseline: all three original installed-peer typechecks passed before edits (auth source; authz and Access source/tests).

Current checks use the coordinator's linked workspace and final rebuilt local package declarations, including nongeneric Token, invariant InjectionToken/TypedToken and mandatory factory inject tuples, not registry copies:

- Auth source and full source/test typecheck pass. The complete test typecheck uses `/tmp/vela-auth-tests-tsconfig.json`, extending auth/tsconfig.json and including all auth/src/**/*.ts (no test exclusion). Generic plugin API and injected factory tuple inference are covered by expectTypeOf tests. A compile-only negative regression rejects explicit tuple generics that omit runtime inject evidence.
- Auth suite: 73/73 passed after the root-owned testing harness was migrated to checked override descriptors and rebuilt. Full auth source/test typecheck also passed against that rebuilt harness. The intermediate 4 override failures are resolved; no compatibility workaround was added.
- Authz source/test typecheck and build pass. Full suite: 29 tests passed, including WS identity replacement during asynchronous authorization.
- Access source/test typecheck and build pass; full suite: 87 tests passed.
- Dedicated core trusted identity plus existing core throttler tests: 21 passed across 2 files.
- All three package builds, publint checks, and attw ESM/bundler package resolution checks pass (CommonJS/Node10 are intentionally outside the declared esm-only profile).
- Lint completed without errors. Existing Nest-style empty-class warnings and intentional sequential permission/resolver warnings remain.
- Changed-file formatting and git diff --check pass.
- D1 example source typecheck and TypeScript build pass with the coordinator's new workspace manifest/dependencies. Wrangler/D1 runtime smoke was not run in this lane.

Security regressions exercise signed local RSA/JWKS fixtures, tenant-aware Access editor permission decisions, missing permissions/engines/ambiguous engines, stale/rejected/expired identity clearing, same-IP principal throttling, normalized WS getters and attachment isolation, full session validation, public/optional behavior, real logout, expiry during async resolution, and provider payload invalidation after identity replacement. No external credentials or remote authentication network calls are used.

## API migrations

- Import PermissionGuard, RequirePermission, RolesGuard and Roles from `@velajs/authz/vela`, for either authentication provider. AccessPermissionGuard and RequireAccessPermission were removed; Better Auth no longer exports duplicate permission/role implementations.
- Read common authority through core getTrustedRequestIdentity(request) or authz CurrentIdentity. Delete reads/writes of AUTH_USER_KEY, AUTH_SESSION_KEY, issuer/type compatibility keys, ACCESS_IDENTITY_KEY, ACCESS_EXP_KEY and ambient Hono userId. Remove betterAuthInterop.
- Better Auth CurrentUser/CurrentSession and Access CurrentAccessIdentity remain provider payload accessors, tied to the current core identity. Mapped Access fields remain available through CurrentAccessIdentity; common verified JWT fields are also in CurrentIdentity.claims.
- Configure tenantClaim for a signed nonstandard tenant field; mapClaims().tenantId is rejected.
- BetterAuthInstance is a minimal runtime contract with getSession returning unknown. Use the concrete BetterAuthService generic for plugin APIs. BETTER_AUTH_OPTIONS contains BetterAuthRuntimeOptions, not the lazily constructed auth instance.
- Remove defaultPolicy; authentication remains deny-by-default. Use Public/OptionalAuth for anonymous behavior. The legacy default-path BetterAuthCatchallController alias is removed; use createBetterAuthCatchallController().
- Raw provider objects migrate to defineProvider. Async auth factories require an explicit inject tuple (use [] for no dependencies); caller-supplied tuple generics cannot replace runtime injection evidence. Factory tuple constraints use nongeneric Token identities. Factories return the auth instance directly, not an options wrapper. Generic policy composition now requires valid context/resource input types instead of erasing them.
- The D1 example uses an InjectionToken<WorkerEnv>, injects env.DB directly, and exports createCloudflareWorker(...) without top-level environment capture.

## Boundaries / remaining integration work

No unsafe assertions or explicit any remain in auth/authz/Access production source touched by this lane. Core uses only `as const` to retain tuple/literal inference. There is no unavoidable reflection cast to document. Runtime predicates check the fields they claim; provider results and untyped claims are validated rather than asserted.

The root owns package/workspace manifests, lockfiles, general core changes, the shared testing harness, and Cloudflare routing. This lane edited only the three owned package sources/tests/docs/changesets plus the explicitly delegated core trusted identity file and its dedicated tests. Root-authored manifest/lockfile/example-tsconfig changes were preserved. The D1 example's runtime smoke and the final all-workspace suite remain coordinator integration checks. This lane's final source/test checks are all green: 189 package tests plus 21 core identity/throttler tests. Core identity consumers should share one package instance, which the root workspace now links consistently.

No commits, publication, deployment, tasks or subagents were created by this lane. MODERNIZATION.md was not edited.

## Modified files owned by this lane

### auth

- `auth/.changeset/canonical-trusted-identity.md`
- `auth/README.md`
- `auth/examples/auth-lab-d1/README.md`
- `auth/examples/auth-lab-d1/src/app.ts`
- `auth/examples/auth-lab-d1/src/worker.ts`
- `auth/examples/auth-lab-d1/src/wrangler-smoke.ts`
- `auth/examples/auth-lab-plugins/src/app.ts`
- `auth/examples/auth-lab-plugins/src/magic-link-auth.module.ts`
- `auth/src/__tests__/acting-as.test.ts`
- `auth/src/__tests__/auth.guard.test.ts`
- `auth/src/__tests__/authz-bridge.test.ts`
- `auth/src/__tests__/better-auth.module.test.ts`
- `auth/src/__tests__/fixtures.ts`
- `auth/src/__tests__/identity-lifecycle.test.ts`
- `auth/src/__tests__/permission-guard.test.ts`
- `auth/src/__tests__/require-permission.decorator.test.ts`
- `auth/src/__tests__/testing-override.test.ts`
- `auth/src/__tests__/types.test.ts`
- `auth/src/auth-request-state.ts`
- `auth/src/authz-bridge.ts`
- `auth/src/better-auth.controller.ts`
- `auth/src/better-auth.module.ts`
- `auth/src/better-auth.service.ts`
- `auth/src/better-auth.tokens.ts`
- `auth/src/better-auth.types.ts`
- `auth/src/decorators/current-session.decorator.ts`
- `auth/src/decorators/current-user.decorator.ts`
- `auth/src/decorators/require-permission.decorator.ts`
- `auth/src/decorators/roles.decorator.ts`
- `auth/src/guards/auth.guard.ts`
- `auth/src/guards/permission.guard.ts`
- `auth/src/guards/roles.guard.ts`
- `auth/src/index.ts`
- `auth/src/session-data.ts`
- `auth/src/testing/acting-as.ts`

### authz

- `authz/.changeset/resolved-async-options.md`
- `authz/.changeset/shared-trusted-authorization.md`
- `authz/README.md`
- `authz/src/__tests__/can.test.ts`
- `authz/src/__tests__/policy.test.ts`
- `authz/src/can.ts`
- `authz/src/identity.ts`
- `authz/src/policy.ts`
- `authz/src/vela/__tests__/authz.module.test.ts`
- `authz/src/vela/__tests__/context-identity.test.ts`
- `authz/src/vela/authz.module.ts`
- `authz/src/vela/context-identity.ts`
- `authz/src/vela/current-identity.decorator.ts`
- `authz/src/vela/index.ts`
- `authz/src/vela/permission.guard.ts`
- `authz/src/vela/require-permission.decorator.ts`
- `authz/src/vela/roles.decorator.ts`
- `authz/src/vela/roles.guard.ts`

### cloudflare-access

- `cloudflare-access/.changeset/canonical-trusted-identity.md`
- `cloudflare-access/README.md`
- `cloudflare-access/src/__tests__/resolver.test.ts`
- `cloudflare-access/src/__tests__/vela.test.ts`
- `cloudflare-access/src/resolver.ts`
- `cloudflare-access/src/types.ts`
- `cloudflare-access/src/vela/access-request-state.ts`
- `cloudflare-access/src/vela/access.guard.ts`
- `cloudflare-access/src/vela/access.module.ts`
- `cloudflare-access/src/vela/authz-bridge.ts`
- `cloudflare-access/src/vela/current-identity.decorator.ts`
- `cloudflare-access/src/vela/index.ts`
- `cloudflare-access/src/vela/permission.guard.ts`
- `cloudflare-access/src/vela/require-permission.decorator.ts`
- `cloudflare-access/src/vela/tokens.ts`
- `cloudflare-access/src/verify.ts`

### Delegated core files

- `vela/src/http/trusted-request-identity.ts`
- `vela/src/__tests__/trusted-request-identity.test.ts`

The existing `authz/.changeset/resolved-async-options.md` is pre-existing; its regression/fix was retained while the module provider and test lookup migrated to the new typed core APIs. New lane changesets are canonical-trusted-identity (auth and Access) and shared-trusted-authorization (authz).
