# @velajs/tenant

## 2.0.0

### Major Changes

- a2d2692: Require the Vela 2 module/runtime peer line. Packages that raise their framework or adapter peer requirement ship a major version so existing 1.x installations are not offered an incompatible patch release. Upgrade the related framework integrations together; native queue/bootstrap migration is documented in docs/module-workers.md.

### Patch Changes

- Updated dependencies [b99d71a]
  - @velajs/vela@2.0.0

## 1.24.1

### Patch Changes

- c5a3cb0: Preserve authentication payload through verified tenant admission while retaining
  invalidation on expiry, clear and reauthentication. Add explicit HTTP-backed
  execution-context identity binding for custom dispatchers, and add a redacting
  Secret value with runtime-private signing
  credentials. Existing authentication and signing entrypoints remain compatible.
- Updated dependencies [c6a43a6]
- Updated dependencies [bbe62d4]
- Updated dependencies [a6ef933]
- Updated dependencies [dae3654]
- Updated dependencies [77cca9e]
- Updated dependencies [b9f75f5]
- Updated dependencies [df47ea8]
- Updated dependencies [af019bf]
- Updated dependencies [6df1059]
- Updated dependencies [bdd90a1]
- Updated dependencies [8a3923f]
- Updated dependencies [c7d108b]
- Updated dependencies [1c7f635]
- Updated dependencies [636ffbc]
- Updated dependencies [54f8864]
- Updated dependencies [f49db45]
- Updated dependencies [4fde903]
- Updated dependencies [6a1b5b3]
- Updated dependencies [a95951a]
- Updated dependencies [9e82187]
- Updated dependencies [c5a3cb0]
- Updated dependencies [363fb71]
- Updated dependencies [de4e57e]
- Updated dependencies [0765aaa]
- Updated dependencies [6b7cf23]
- Updated dependencies [5205e58]
- Updated dependencies [ae45689]
  - @velajs/vela@1.25.0

## 1.24.0

### Minor Changes

- fe7587f: Add Standard Schema validation and operation contracts, authoritative tenant admission and audited persistence, optional Cedar authorization with exact query plans, and Web Crypto envelope/field/file encryption. Complete compound CRUD identifiers, parent scopes, structured predicates, signed cursors, page projections and post-commit delivery. Add transactional memory and Durable Object SQLite adapters, with D1/Workers and PostgreSQL conformance coverage.

### Patch Changes

- Updated dependencies [fe7587f]
  - @velajs/vela@1.24.0

## Unreleased

- Add the portable edge capability and optional integrations described in the package README.
