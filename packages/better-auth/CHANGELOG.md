# Changelog

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
