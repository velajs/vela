# @velajs/crud-durable-objects

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
