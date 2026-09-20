# @velajs/studio

## 1.22.0

### Minor Changes

- Continue the coordinated framework release on the 1.x line with the current checked provider, endpoint, identity, CRUD, live, and Studio APIs. Breaking API changes are accepted during this development phase; maintained applications use the current contracts.
- Publish from the pnpm packages workspace with TypeScript 7 and GitHub OIDC. Obsolete standalone examples have been removed; runnable applications live in apps/.
- Updated workspace dependencies
  - @velajs/better-auth@1.22.0
  - @velajs/cloudflare@1.22.0
  - @velajs/crud@1.22.0
  - @velajs/errors@1.22.0
  - @velajs/feature-flags@1.22.0
  - @velajs/studio-protocol@1.22.0
  - @velajs/vela@1.22.0

## 2.0.1

### Patch Changes

- Publish from the unified packages workspace with corrected repository paths, shared native tooling, TypeScript 7 checks, and npm OIDC releases. Runnable examples now live in apps/.
- Updated dependencies
  - @velajs/vela@2.0.1
  - @velajs/errors@2.0.1
  - @velajs/better-auth@2.0.1
  - @velajs/cloudflare@2.0.1
  - @velajs/feature-flags@2.0.1
  - @velajs/crud@2.0.1
  - @velajs/studio-protocol@2.0.1

## 2.0.0

Initial coordinated release: authenticated admin operations, checked wire schemas, native Worker try-it boundaries, and opt-in read-only live/presence inspection.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.
