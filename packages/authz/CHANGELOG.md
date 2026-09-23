# Changelog

## 1.29.0

### Minor Changes

- 4071cb7: The built-in guards inject the application `Reflector` instead of constructing their own: `AuthGuard` (`@velajs/better-auth`), `FeatureFlagGuard` (`@velajs/feature-flags`), `PermissionGuard` and `RolesGuard` (`@velajs/authz/vela`), `TenantGuard` (`@velajs/tenant/vela`) and `CedarGuard` (`@velajs/authz-cedar/vela`). `PermissionGuard`, `RolesGuard` and `TenantGuard` are now injectable, so `@UseGuards()` builds them in the declaring module through DI, like any provider.
  
  **Behavior change:** each guard takes the `Reflector` as a constructor parameter, after any dependencies it already had: `new PermissionGuard(reflector)`, `new RolesGuard(reflector)`, `new TenantGuard(reflector)`, `new CedarGuard(reflector)`, `new AuthGuard(auth, options, reflector)` and `new FeatureFlagGuard(flags, reflector)`. Code that constructs a guard itself, such as `app.useGlobalGuards(new TenantGuard(app.get(Reflector)))` or a unit test, passes the application's `Reflector` or a `new Reflector()`, and a subclass that declares its own constructor passes it to `super()`. A guard class passed to `app.useGlobalGuards()` is built through DI only when a module registers it, including the copy a module registers for a `@UseGuards()` reference; otherwise pass an instance or register it as `{ provide: APP_GUARD, useClass: PermissionGuard }`. Guards resolved through DI need no change.

### Patch Changes

- e3bda2a: Module-level `@UseGuards`, `@UseInterceptors`, `@UsePipes`, `@UseFilters` and `@UseMiddleware` now run once per request when the same module classes are bootstrapped more than once in an isolate (per-environment rebuilds, Durable Object instances, tests). Previously every bootstrap added another copy to the module's controllers, so later applications wrapped responses twice and ran guards such as throttling twice.
  
  **Behavior change:** module-level components are resolved per application from the module instance that declares the controller instead of being copied onto the controller's metadata. `MetadataRegistry.propagateControllerComponents()` is removed, and `MetadataRegistry.getController()` returns only a class's own decorations. The static `ComponentManager.getScopedComponents(type, controller, handlerName)` from `@velajs/vela/internal` is removed; use the new `getScopedComponents(type, class, method, container, moduleId)` from `@velajs/vela` instead, which reads the declared entries, module-level ones included, without constructing them; `resolveScopedComponents()` and `resolveScopedComponentsAsync()` include them for the owning `moduleId` (or the class's only owner when it is omitted). The `@velajs/authz` authorization audit and `@velajs/mail` inbound dispatch recognize module-level components the same way.
- Updated dependencies [07d1713]
- Updated dependencies [db18d3a]
- Updated dependencies [07d1713]
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

## 1.28.0

### Minor Changes

- Continue the module-based Workers APIs on the 1.x release line. Vela permits breaking changes in minor releases and does not retain compatibility layers. Upgrade the framework and integrations together for native queue dispatch, cron scheduling, RPC modules and asynchronous roots; see docs/module-workers.md.

### Patch Changes

- Updated dependencies
  - @velajs/vela@1.28.0

## 3.0.0

### Major Changes

- Publish module-based Workers on the unused 3.x stable release line. Earlier experimental 2.0.0 registry versions are immutable and do not contain this release. Upgrade the framework and integrations together; see docs/module-workers.md for queue bootstrap, native delivery, RPC modules and async root migration details.

### Patch Changes

- Updated dependencies
  - @velajs/vela@3.0.0

## 2.0.0

### Major Changes

- a2d2692: Require the Vela 2 module/runtime peer line. Packages that raise their framework or adapter peer requirement ship a major version so existing 1.x installations are not offered an incompatible patch release. Upgrade the related framework integrations together; native queue/bootstrap migration is documented in docs/module-workers.md.

### Patch Changes

- Updated dependencies [b99d71a]
  - @velajs/vela@2.0.0

## 1.23.0

### Minor Changes

- 68c26a3: Add an opt-in mounted HTTP authorization wiring audit. Inspect effective permission/role metadata, built-in guard registration, and module-visible authorization engines without constructing providers. Report opaque factories and custom guards as unverified; support startup errors or warning diagnostics.

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
- Updated dependencies [363fb71]
- Updated dependencies [de4e57e]
- Updated dependencies [0765aaa]
- Updated dependencies [6b7cf23]
- Updated dependencies [5205e58]
- Updated dependencies [ae45689]
  - @velajs/vela@1.25.0

## 1.22.1

### Patch Changes

- Publish from the public velajs/vela repository through GitHub Actions OIDC with required signed npm provenance. Attestations identify the source commit and release workflow for each package.
- Updated dependencies
  - @velajs/vela@1.22.1

## 1.22.0

### Minor Changes

- Continue the coordinated framework release on the 1.x line with the current checked provider, endpoint, identity, CRUD, live, and Studio APIs. Breaking API changes are accepted during this development phase; maintained applications use the current contracts.
- Publish from the pnpm packages workspace with TypeScript 7 and GitHub OIDC. Obsolete standalone examples have been removed; runnable applications live in apps/.
- Updated workspace dependencies
  - @velajs/vela@1.22.0

## 2.0.1

### Patch Changes

- Publish from the unified packages workspace with corrected repository paths, shared native tooling, TypeScript 7 checks, and npm OIDC releases. Runnable examples now live in apps/.
- Updated dependencies
  - @velajs/vela@2.0.1

## 2.0.0

Provider-independent authorization consumes the shared verified identity, including tenant and expiry checks.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.

## 1.1.0

### Minor Changes

- d36de0e: Add issuer-scoped `subject` and `principalType` fields to the identity contract while retaining `userId` as a compatibility alias.

## 1.0.1

### Patch Changes

- 307ff5e: Modernize the package build, validation, and release toolchain.

All notable changes to `@velajs/authz` are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.0

Initial release — the framework-agnostic permission/role engine for Vela.

### Added

- **`Identity` / `PermissionResolver`** — the model at the core. `Identity` is who is asking (all fields optional, so `{}` and `anonymous` are valid zero-privilege identities); `PermissionResolver` is the single seam that resolves an identity to its granted-permission `Set` (sync or async). `anonymous` (`{ roles: [] }`, frozen) is the fail-closed default when no session is present.
- **`defineRole` / `definePermission`** — declare the role→permission table. `defineRole(name, permissions)` copies the permissions array, so the returned `RoleDef` never aliases the caller's input; `definePermission(name)` names a permission for the optional allow-list.
- **`createAuthz`** — builds an `Authz` (`{ can, resolver }`) over a role table or a custom `resolver`. Passing a `permissions` allow-list turns typos into a build-time error: `createAuthz` throws when a role grants an **undeclared** (non-wildcard) permission.
- **Fail-closed `can()` + wildcards** — `can(identity, permission, resolver)` (and the bound `authz.can`) default to **deny**. No session, unknown role, missing permission, or a resolver that **throws** all deny — there is no allow-on-error path. On the **granted** side, `*` grants everything and `resource:*` grants any action under that resource (e.g. `posts:*` grants `posts:delete`).
- **`anyOf` / `allOf` / `hasPerm` / `mask`** — composition + masking over a `Policy` (a plain predicate over a context and a resource). `anyOf` is OR/read semantics (empty → **denied**); `allOf` is AND/write semantics (empty → vacuously true); `hasPerm(authz, permission)` bridges a capability check into a `Policy` reading only `ctx.identity`; `mask(fn)` wraps a field transform so a throw redacts to `null` instead of leaking the raw value. A policy that throws inside `anyOf`/`allOf` denies that branch — it can never allow.
- **`@velajs/authz/vela` — `AuthzModule`** — optional Vela integration behind a subpath. Built on `@velajs/vela`'s `defineModule`, `AuthzModule.forRoot(options)` provides an `Authz` instance (`createAuthz(options)`) under the `AUTHZ` token and exports it for other modules to inject. `@velajs/vela` is an **optional** peer dependency — the core engine has no framework coupling.

### Notes

- Zero runtime dependencies; ESM; `sideEffects: false`; edge-runtime safe (no `node:*`, `Buffer`, or `process`).
