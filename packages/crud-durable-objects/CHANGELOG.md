# @velajs/crud-durable-objects

## 1.28.0

### Minor Changes

- Continue the module-based Workers APIs on the 1.x release line. Vela permits breaking changes in minor releases and does not retain compatibility layers. Upgrade the framework and integrations together for native queue dispatch, cron scheduling, RPC modules and asynchronous roots; see docs/module-workers.md.

### Patch Changes

- Updated dependencies
  - @velajs/crud@1.28.0
  - @velajs/crud-drizzle@1.28.0

## 3.0.0

### Major Changes

- Publish module-based Workers on the unused 3.x stable release line. Earlier experimental 2.0.0 registry versions are immutable and do not contain this release. Upgrade the framework and integrations together; see docs/module-workers.md for queue bootstrap, native delivery, RPC modules and async root migration details.

### Patch Changes

- Updated dependencies
  - @velajs/crud@3.0.0
  - @velajs/crud-drizzle@3.0.0

## 2.0.0

### Major Changes

- a2d2692: Require the Vela 2 module/runtime peer line. Packages that raise their framework or adapter peer requirement ship a major version so existing 1.x installations are not offered an incompatible patch release. Upgrade the related framework integrations together; native queue/bootstrap migration is documented in docs/module-workers.md.

### Patch Changes

- Updated dependencies [a2d2692]
  - @velajs/crud@2.0.0
  - @velajs/crud-drizzle@2.0.0

## 1.24.1

### Patch Changes

- a66a3cb: Add typed named database registrations, explicit module/resource routing, database-qualified resource identities and isolated default stores. Preserve single-database authoring and native handle inference.

  Add explicit same-owner resource transaction composition with tenant/lifetime checks, rollback after caught operation errors, draining of accepted work, and ordered outer-commit notifications. Validate native Drizzle scopes and preserve genuine Durable Object transactions. D1 callbacks, cross-database atomicity and composition with non-transaction-aware versioning stores fail explicitly.
- Updated dependencies [1ee888a]
- Updated dependencies [6588211]
- Updated dependencies [a66a3cb]
- Updated dependencies [de4e57e]
- Updated dependencies [cc0dcfd]
  - @velajs/crud-drizzle@1.24.1
  - @velajs/crud@1.25.0

## 1.24.0

### Minor Changes

- fe7587f: Add Standard Schema validation and operation contracts, authoritative tenant admission and audited persistence, optional Cedar authorization with exact query plans, and Web Crypto envelope/field/file encryption. Complete compound CRUD identifiers, parent scopes, structured predicates, signed cursors, page projections and post-commit delivery. Add transactional memory and Durable Object SQLite adapters, with D1/Workers and PostgreSQL conformance coverage.

### Patch Changes

- Updated dependencies [fe7587f]
  - @velajs/crud@1.24.0
  - @velajs/crud-drizzle@1.24.0

## Unreleased

- Add the portable edge capability and optional integrations described in the package README.
