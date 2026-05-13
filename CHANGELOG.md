# Changelog

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
