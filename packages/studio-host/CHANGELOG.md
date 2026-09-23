# @velajs/studio-host

## 1.23.0

### Minor Changes

- 41ec70d: Name the default provider lifetime `Scope.DEFAULT`, as Nest does.
  
  **Behavior change:** Scope.SINGLETON is renamed Scope.DEFAULT (Nest naming); no alias. Replace every `Scope.SINGLETON` with `Scope.DEFAULT`. The member's runtime value changes from `'singleton'` to `'default'`, so `getScope`, `Container.getProviderScope`, `Container.getResolvedScope`, `DiscoveryService` registrations and the conflicting-scope decorator error now report `default`. Code that compares a scope against the string `'singleton'` must compare against `Scope.DEFAULT` instead.
  
  **Behavior change:** Studio's `app.modules` provider scopes and `app.entrypoints` scopes label that lifetime `default` instead of `singleton`. `StudioProviderScope` is now `'default' | 'transient' | 'request'`, and the response validators reject `singleton`. Because an op's payload changed, `STUDIO_PROTOCOL_VERSION` is now 3 and `StudioConnection.protocolVersion` is typed as that constant. The Studio UI rejects a health probe or host connection that reports another version with its protocol-mismatch error instead of failing on the first scope label, so upgrade `@velajs/vela`, `@velajs/studio`, `@velajs/studio-ui` and `@velajs/studio-host` together.

### Patch Changes

- Updated dependencies [41ec70d]
  - @velajs/studio-protocol@1.24.0
  - @velajs/studio-ui@1.24.0

## 1.22.2

### Patch Changes

- Updated dependencies [c5d98a7]
- Updated dependencies [8b3ba80]
  - @velajs/studio-protocol@1.23.0
  - @velajs/studio-ui@1.23.0

## 1.22.1

### Patch Changes

- Publish from the public velajs/vela repository through GitHub Actions OIDC with required signed npm provenance. Attestations identify the source commit and release workflow for each package.
- Updated dependencies
  - @velajs/studio-protocol@1.22.1
  - @velajs/studio-ui@1.22.1

## 1.22.0

### Minor Changes

- Continue the coordinated framework release on the 1.x line with the current checked provider, endpoint, identity, CRUD, live, and Studio APIs. Breaking API changes are accepted during this development phase; maintained applications use the current contracts.
- Publish from the pnpm packages workspace with TypeScript 7 and GitHub OIDC. Obsolete standalone examples have been removed; runnable applications live in apps/.
- Updated workspace dependencies
  - @velajs/studio-protocol@1.22.0
  - @velajs/studio-ui@1.22.0

## 2.0.1

### Patch Changes

- Publish from the unified packages workspace with corrected repository paths, shared native tooling, TypeScript 7 checks, and npm OIDC releases. Runnable examples now live in apps/.
- Updated dependencies
  - @velajs/studio-ui@2.0.1
  - @velajs/studio-protocol@2.0.1

## 2.0.0

Initial coordinated release: loopback Studio host with separate host, admin and application request credentials.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.
