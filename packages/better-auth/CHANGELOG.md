# Changelog

## 1.29.0

### Minor Changes

- 2dd809d: `BetterAuthModule.forRoot({ key })` and `forRootAsync({ key })` no longer throw when a root is rebuilt with the same explicit key in one isolate, for example per Worker environment or per Durable Object. Within an application, the same registration still deduplicates.
  
  **Behavior change:** an explicit `key` no longer rejects a different registration that reuses it within one application. The key now labels a registration instead of claiming it: the options shape and the auth instance (or `useFactory`) stay part of the module's identity, so each distinct registration under the same key, one with a different auth instance, factory or options, becomes its own module instance, as a registration without a key does. Previously the second registration threw. Use distinct keys, or pass the same auth instance or factory and options, when one application should hold a single registration.
- 8a3016c: Add `BetterAuthUpgradeAuthenticator` for `@WebSocketGateway({ authenticator: BetterAuthUpgradeAuthenticator })`. It reads the session cookie through the module's `BetterAuthService`, validates the full session, and issues a WebSocket identity under the `BetterAuthModule` issuer, as `AuthGuard` does for HTTP, expiring with the session. The tenant is the session's active organization; provide `BETTER_AUTH_UPGRADE_TENANT` in the module that declares the gateway to choose it per connection (`(session, context, request) => tenantId | undefined`). Without a tenant, the upgrade is refused.
- 4071cb7: The built-in guards inject the application `Reflector` instead of constructing their own: `AuthGuard` (`@velajs/better-auth`), `FeatureFlagGuard` (`@velajs/feature-flags`), `PermissionGuard` and `RolesGuard` (`@velajs/authz/vela`), `TenantGuard` (`@velajs/tenant/vela`) and `CedarGuard` (`@velajs/authz-cedar/vela`). `PermissionGuard`, `RolesGuard` and `TenantGuard` are now injectable, so `@UseGuards()` builds them in the declaring module through DI, like any provider.
  
  **Behavior change:** each guard takes the `Reflector` as a constructor parameter, after any dependencies it already had: `new PermissionGuard(reflector)`, `new RolesGuard(reflector)`, `new TenantGuard(reflector)`, `new CedarGuard(reflector)`, `new AuthGuard(auth, options, reflector)` and `new FeatureFlagGuard(flags, reflector)`. Code that constructs a guard itself, such as `app.useGlobalGuards(new TenantGuard(app.get(Reflector)))` or a unit test, passes the application's `Reflector` or a `new Reflector()`, and a subclass that declares its own constructor passes it to `super()`. A guard class passed to `app.useGlobalGuards()` is built through DI only when a module registers it, including the copy a module registers for a `@UseGuards()` reference; otherwise pass an instance or register it as `{ provide: APP_GUARD, useClass: PermissionGuard }`. Guards resolved through DI need no change.
- 4071cb7: A factory without parameters may omit `inject` in `BetterAuthModule.forRootAsync()`, `MailModule.forRootAsync()`, `StorageModule.forRootAsync()`, `RpcClientModule.registerAsync()` and `overrideProvider(token).useFactory({ factory })`, as in the `@velajs/vela` factories. A factory with parameters still names their tokens in `inject`, and a dependency tuple given as a type argument still needs a matching `inject`.
  
  `StorageModule.forRootAsync()` factories may return `{ driver, multipartGrantSecret }` instead of a bare driver, so the multipart grant secret comes through DI, for example from `ENV`, now that roots are static. The factory still runs once, on first use, or again on the next use until it succeeds; its secret takes precedence over `http.multipartGrantSecret` and is validated with the rest of the factory result on each such use, and multipart endpoints without any secret keep refusing every request. Adds the `StorageAsyncResult` and `StorageControllerOptions` types, and `createStorageController()` takes an optional token for the values it resolves per application.
  
  **Behavior change:** a multipart grant secret shorter than 32 bytes is a server configuration error instead of a client error. `StorageModule.forRoot()` throws for such an `http.multipartGrantSecret` when the module is set up, and a `forRootAsync()` factory that returns one fails every storage operation and multipart request until the factory returns a valid result, which the controller answers with a redacted 502 `upstream_error`. Multipart requests no longer answer 400 `invalid_request` with a message that names the setting.
  
  **Behavior change:** `MailModule.forRootAsync()` and `StorageModule.forRootAsync()` throw when called with a factory that declares parameters but no `inject`, naming the method, instead of running it with `undefined` arguments. `MailModuleAsyncOptions`, `StorageModuleAsyncOptions` and `RpcClientAsyncOptions` are type aliases instead of interfaces, so an interface can no longer extend them: intersect them instead (`RpcClientAsyncOptions<Inject> & { region: string }`). `MailModuleAsyncOptions.imports` is typed `ModuleImport[]`, so a caller that enables `exactOptionalPropertyTypes` omits it instead of passing `undefined`.

### Patch Changes

- Updated dependencies [07d1713]
- Updated dependencies [db18d3a]
- Updated dependencies [07d1713]
- Updated dependencies [4071cb7]
- Updated dependencies [bacaacd]
- Updated dependencies [a814199]
- Updated dependencies [1838474]
- Updated dependencies [8a3016c]
- Updated dependencies [d803a49]
- Updated dependencies [b235935]
- Updated dependencies [08a81c8]
- Updated dependencies [5b5b81d]
- Updated dependencies [7daf4fc]
- Updated dependencies [35e8e0d]
- Updated dependencies [4420501]
- Updated dependencies [ff44b6a]
- Updated dependencies [6d4f0c0]
- Updated dependencies [e3bda2a]
- Updated dependencies [bd7e3c9]
- Updated dependencies [2b74880]
- Updated dependencies [5ba8635]
- Updated dependencies [db0c834]
- Updated dependencies [d6f6a65]
- Updated dependencies [8a3016c]
- Updated dependencies [d5a3ec8]
- Updated dependencies [0f7e8e7]
- Updated dependencies [41ec70d]
- Updated dependencies [b265297]
- Updated dependencies [bdfff47]
- Updated dependencies [28c7d07]
- Updated dependencies [8a3016c]
- Updated dependencies [44efdde]
  - @velajs/vela@1.29.0
  - @velajs/authz@1.29.0

## 1.28.0

### Minor Changes

- Continue the module-based Workers APIs on the 1.x release line. Vela permits breaking changes in minor releases and does not retain compatibility layers. Upgrade the framework and integrations together for native queue dispatch, cron scheduling, RPC modules and asynchronous roots; see docs/module-workers.md.

### Patch Changes

- Updated dependencies
  - @velajs/authz@1.28.0
  - @velajs/vela@1.28.0

## 3.0.0

### Major Changes

- Publish module-based Workers on the unused 3.x stable release line. Earlier experimental 2.0.0 registry versions are immutable and do not contain this release. Upgrade the framework and integrations together; see docs/module-workers.md for queue bootstrap, native delivery, RPC modules and async root migration details.

### Patch Changes

- Updated dependencies
  - @velajs/authz@3.0.0
  - @velajs/vela@3.0.0

## 2.0.0

### Major Changes

- a2d2692: Require the Vela 2 module/runtime peer line. Packages that raise their framework or adapter peer requirement ship a major version so existing 1.x installations are not offered an incompatible patch release. Upgrade the related framework integrations together; native queue/bootstrap migration is documented in docs/module-workers.md.

### Patch Changes

- Updated dependencies [a2d2692]
- Updated dependencies [b99d71a]
  - @velajs/authz@2.0.0
  - @velajs/vela@2.0.0

## 1.22.2

### Patch Changes

- c5a3cb0: Preserve authentication payload through verified tenant admission while retaining
  invalidation on expiry, clear and reauthentication. Add explicit HTTP-backed
  execution-context identity binding for custom dispatchers, and add a redacting
  Secret value with runtime-private signing
  credentials. Existing authentication and signing entrypoints remain compatible.
- Updated dependencies [c6a43a6]
- Updated dependencies [bbe62d4]
- Updated dependencies [a6ef933]
- Updated dependencies [dae3654]
- Updated dependencies [77cca9e]
- Updated dependencies [b9f75f5]
- Updated dependencies [df47ea8]
- Updated dependencies [af019bf]
- Updated dependencies [6df1059]
- Updated dependencies [bdd90a1]
- Updated dependencies [8a3923f]
- Updated dependencies [c7d108b]
- Updated dependencies [1c7f635]
- Updated dependencies [636ffbc]
- Updated dependencies [54f8864]
- Updated dependencies [f49db45]
- Updated dependencies [4fde903]
- Updated dependencies [6a1b5b3]
- Updated dependencies [a95951a]
- Updated dependencies [9e82187]
- Updated dependencies [c5a3cb0]
- Updated dependencies [68c26a3]
- Updated dependencies [363fb71]
- Updated dependencies [de4e57e]
- Updated dependencies [0765aaa]
- Updated dependencies [6b7cf23]
- Updated dependencies [5205e58]
- Updated dependencies [ae45689]
  - @velajs/vela@1.25.0
  - @velajs/authz@1.23.0

## 1.22.1

### Patch Changes

- Publish from the public velajs/vela repository through GitHub Actions OIDC with required signed npm provenance. Attestations identify the source commit and release workflow for each package.
- Updated dependencies
  - @velajs/authz@1.22.1
  - @velajs/vela@1.22.1

## 1.22.0

### Minor Changes

- Continue the coordinated framework release on the 1.x line with the current checked provider, endpoint, identity, CRUD, live, and Studio APIs. Breaking API changes are accepted during this development phase; maintained applications use the current contracts.
- Publish from the pnpm packages workspace with TypeScript 7 and GitHub OIDC. Obsolete standalone examples have been removed; runnable applications live in apps/.
- Updated workspace dependencies
  - @velajs/authz@1.22.0
  - @velajs/vela@1.22.0

## 2.0.1

### Patch Changes

- Publish from the unified packages workspace with corrected repository paths, shared native tooling, TypeScript 7 checks, and npm OIDC releases. Runnable examples now live in apps/.
- Updated dependencies
  - @velajs/vela@2.0.1
  - @velajs/authz@2.0.1

## 2.0.0

Native environment configuration and one immutable verified identity shared with provider-independent authorization.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.

## 1.0.0

### Major Changes

- a468b57: Run guards before ordinary identity parameters, install authentication globally and deny application routes by default, remove the insecure `defaultPolicy: 'allow'` mode and implicit auth-path bypass, enforce canonical auth mount paths, reject ambiguous authorization engines, and key module instances by the actual auth/factory reference. Anonymous routes must now use explicit `@Public()` or `@OptionalAuth()` metadata. Verified sessions now publish Vela's framework-owned principal identity and, when present, the Better Auth organization plugin's `activeOrganizationId` so downstream throttling can partition by principal and tenant before IP fallback.

## 0.6.1

### Patch Changes

- 89f5473: Modernize the package build, validation, and release toolchain.

## 0.4.0 (2026-07-04)

- Rebuilt on vela 1.11 `defineModule` + `lazyProvider` + `provideGlobal` (lazy auth-builder deferral preserved; public API unchanged). Requires `@velajs/vela >=1.11.0`.

All notable changes to `@velajs/better-auth` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.0] — 2026-05-13

### Added

- `BetterAuthModule.forRoot` / `forRootAsync` — wires a pre-constructed
  `betterAuth({...})` instance into a Vela application. `isGlobal` registers
  `AuthGuard` as `APP_GUARD` (deny-by-default).
- `AuthGuard` — singleton guard that reads `auth.api.getSession({ headers })`
  and populates `REQUEST_CONTEXT` with the user and session.
- `RolesGuard` — reads `@Roles([...])` metadata and compares against
  `user.role` (compatible with better-auth's admin plugin field).
- `@CurrentUser()` / `@CurrentSession()` — lazy parameter decorators built on
  `createLazyParamDecorator`, so they correctly observe guard-populated state.
- `@Public(true)` / `@OptionalAuth(true)` — class- and method-level overrides.
- `@Roles([...])` — typed `Reflector.createDecorator<string[]>` for role gating.
- `BETTER_AUTH` injection token — exposes the live `betterAuth()` instance to
  any vela service or controller via `@Inject(BETTER_AUTH)`.
- `BetterAuthCatchallController` — auto-mounts `/api/auth/*` (delegates to
  `auth.handler`). Marked `@Public(true)` so the global guard never blocks
  better-auth's own routes. Opt out with `mountHandler: false`.
- `examples/auth-lab` — end-to-end smoke (13 in-process checks) demonstrating
  sign-up / sign-in / sign-out / protected route / public route / service
  injection with `better-auth`'s `memoryAdapter`.

### Notes

- Edge-clean: `dist/` contains no `node:*` imports, `Buffer`, or `process.*`
  references. Edge-safety of the runtime ultimately depends on the database
  adapter the consumer chooses; see the README's adapter matrix.
- Requires `@velajs/vela ≥ 1.6.0` (introduces `createLazyParamDecorator`).
- Peer-deps `better-auth ≥ 1.2.0`, `hono ≥ 4`.

[Unreleased]: https://github.com/velajs/better-auth/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/velajs/better-auth/releases/tag/v0.1.0
