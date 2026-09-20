# Changelog

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
