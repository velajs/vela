# @velajs/live-protocol

## 1.22.1

### Patch Changes

- Publish from the public velajs/vela repository through GitHub Actions OIDC with required signed npm provenance. Attestations identify the source commit and release workflow for each package.

## 1.22.0

### Minor Changes

- Continue the coordinated framework release on the 1.x line with the current checked provider, endpoint, identity, CRUD, live, and Studio APIs. Breaking API changes are accepted during this development phase; maintained applications use the current contracts.
- Publish from the pnpm packages workspace with TypeScript 7 and GitHub OIDC. Obsolete standalone examples have been removed; runnable applications live in apps/.

## 2.0.1

### Patch Changes

- Publish from the unified packages workspace with corrected repository paths, shared native tooling, TypeScript 7 checks, and npm OIDC releases. Runnable examples now live in apps/.

## 2.0.0

Shared runtime argument/result parsers and validated live frame contracts used by the server and every client.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.

## 1.1.0

### Minor Changes

- 6e9d70a: Validate live frame schemas, JSON shape, protocol versions, cursor/epoch pairs, and secure default size limits for frames, deltas, and presence metadata. Outbound encoders now reject malformed or oversized frames before serialization.

## 1.0.1

### Patch Changes

- 0fcf971: Modernize the package build, validation, and release toolchain.
