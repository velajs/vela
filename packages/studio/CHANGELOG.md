# @velajs/studio

## 3.0.0

### Major Changes

- Publish module-based Workers on the unused 3.x stable release line. Earlier experimental 2.0.0 registry versions are immutable and do not contain this release. Upgrade the framework and integrations together; see docs/module-workers.md for queue bootstrap, native delivery, RPC modules and async root migration details.

### Patch Changes

- Updated dependencies
  - @velajs/better-auth@3.0.0
  - @velajs/cloudflare@3.0.0
  - @velajs/crud@3.0.0
  - @velajs/feature-flags@3.0.0
  - @velajs/vela@3.0.0

## 2.0.0

### Major Changes

- a2d2692: Require the Vela 2 module/runtime peer line. Packages that raise their framework or adapter peer requirement ship a major version so existing 1.x installations are not offered an incompatible patch release. Upgrade the related framework integrations together; native queue/bootstrap migration is documented in docs/module-workers.md.

### Patch Changes

- Updated dependencies [a2d2692]
- Updated dependencies [b99d71a]
  - @velajs/better-auth@2.0.0
  - @velajs/crud@2.0.0
  - @velajs/feature-flags@2.0.0
  - @velajs/vela@2.0.0
  - @velajs/cloudflare@2.0.0

## 1.23.0

### Minor Changes

- c5d98a7: Use the shared CRUD database resolver for Studio resources, expose qualified database/resource identities, and reject ambiguous legacy names or invalid explicit selections. Keep relation inspection and generated foreign keys within the selected database. Preserve native compiled CRUD adapters and fail before writes when time-based CDC replay would require an unavailable database-aware change source.
- 8b3ba80: Add optional application-owned structured log capture and handler completion timing through `@velajs/studio/logging`. Expose additive module ownership, effective provider scopes, and invocation metadata in Studio protocol v2 and the UI. Bound and copy log snapshots, preserve older protocol responses, and document Worker/test debugger workflows.

### Patch Changes

- 7a4b7bc: Bound Studio entrypoint metadata snapshots, make bigint and cycles JSON-safe, and avoid traversing getters or live class instances. Copy route descriptions at the inspection boundary and avoid duplicate GET rows for attributed HEAD handlers.
- 9638591: Report caught admin RPC errors once through the configured application logger and exception policy, preserving invocation correlation while keeping raw error details out of the client response.
- 8f6b19e: Discover admin handlers without constructing them, reject duplicate confirmation summaries, and resolve handlers and summaries asynchronously in their owning module and invocation scope. Preserve symbol methods and private receivers while enforcing write gates before construction.
- Updated dependencies [c6a43a6]
- Updated dependencies [bbe62d4]
- Updated dependencies [a6ef933]
- Updated dependencies [dae3654]
- Updated dependencies [26fe8bf]
- Updated dependencies [77cca9e]
- Updated dependencies [b9f75f5]
- Updated dependencies [df47ea8]
- Updated dependencies [af019bf]
- Updated dependencies [6df1059]
- Updated dependencies [bdd90a1]
- Updated dependencies [8a3923f]
- Updated dependencies [c7d108b]
- Updated dependencies [6588211]
- Updated dependencies [1c7f635]
- Updated dependencies [636ffbc]
- Updated dependencies [54f8864]
- Updated dependencies [f49db45]
- Updated dependencies [a66a3cb]
- Updated dependencies [4fde903]
- Updated dependencies [6a1b5b3]
- Updated dependencies [a95951a]
- Updated dependencies [9e82187]
- Updated dependencies [c5a3cb0]
- Updated dependencies [363fb71]
- Updated dependencies [de4e57e]
- Updated dependencies [c5d98a7]
- Updated dependencies [8b3ba80]
- Updated dependencies [0765aaa]
- Updated dependencies [cc0dcfd]
- Updated dependencies [6b7cf23]
- Updated dependencies [5205e58]
- Updated dependencies [ae45689]
  - @velajs/vela@1.25.0
  - @velajs/cloudflare@1.23.0
  - @velajs/crud@1.25.0
  - @velajs/better-auth@1.22.2
  - @velajs/studio-protocol@1.23.0
  - @velajs/feature-flags@1.22.1

## 1.22.1

### Patch Changes

- Publish from the public velajs/vela repository through GitHub Actions OIDC with required signed npm provenance. Attestations identify the source commit and release workflow for each package.
- Updated dependencies
  - @velajs/better-auth@1.22.1
  - @velajs/cloudflare@1.22.1
  - @velajs/crud@1.22.1
  - @velajs/errors@1.22.1
  - @velajs/feature-flags@1.22.1
  - @velajs/studio-protocol@1.22.1
  - @velajs/vela@1.22.1

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
