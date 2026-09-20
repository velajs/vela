# @velajs/studio-host

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
