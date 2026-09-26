# @velajs/crypto

## 1.30.0

### Minor Changes

- 9a00506: Align module APIs with instance ownership: shared facilities use forRoot, local and named services use register, and Queue, I18n and Seeder contribute declarations through forFeature. Remove replaced APIs. Local registrations receive independent identities; reused definitions share within an application, and explicit keys retain conflict checks.
  
  Require applications to attach exported guards and interceptors explicitly. Remove automatic installation and guard options while preserving policy ownership, request scope, phase ordering, testing overrides and integration-route exemptions. Keep translation contributions and mutable runtime configuration isolated per application, and return runtime-only settings from async factories. Storage separates structural httpController mounting from runtime http options.
  
  Add schema-first GraphQL resolver and parameter decorators with exact provider ownership, endpoint selection and duplicate binding validation. Add the optional Cloudflare workflow-definitions entrypoint to host portable workflows and compiled agents with validated input, per-run dependency resolution, explicit dispatch authority and native replay/error semantics.
  
  Update CLI output, runnable examples, packed consumers and migration documentation together. Keep root Cloudflare declarations usable without installing the optional Feature Flags peer. See docs/module-api-migration.md for the new signatures and required application changes. This is a coordinated breaking change on the 1.x line; no compatibility aliases are retained.

### Patch Changes

- Updated dependencies [9a00506]
  - @velajs/vela@1.34.0
  - @velajs/tenant@1.32.0

## 1.29.0

### Minor Changes

- 3cc469d: Preserve native Flagship evaluation reasons, variants and error codes through optional driver detail methods and Studio responses. Value-only providers now report UNKNOWN instead of STATIC; native context accepts only scalar attributes, and route guards deny all evaluation errors. Existing object-validation callback signatures are unchanged.
  
  Add the optional crypto/cloudflare SecretsStoreKeyProvider for immutable, versioned AES-KW key material, with explicit per-instance caching, refresh, retry and rotation using retained decryption keys. Secrets Store supplies material for local Web Crypto; it is not a remote KMS.

## 1.28.0

### Minor Changes

- Continue the module-based Workers APIs on the 1.x release line. Vela permits breaking changes in minor releases and does not retain compatibility layers. Upgrade the framework and integrations together for native queue dispatch, cron scheduling, RPC modules and asynchronous roots; see docs/module-workers.md.

### Patch Changes

- Updated dependencies
  - @velajs/tenant@1.28.0
  - @velajs/vela@1.28.0

## 3.0.0

### Major Changes

- Publish module-based Workers on the unused 3.x stable release line. Earlier experimental 2.0.0 registry versions are immutable and do not contain this release. Upgrade the framework and integrations together; see docs/module-workers.md for queue bootstrap, native delivery, RPC modules and async root migration details.

### Patch Changes

- Updated dependencies
  - @velajs/tenant@3.0.0
  - @velajs/vela@3.0.0

## 2.0.0

### Major Changes

- a2d2692: Require the Vela 2 module/runtime peer line. Packages that raise their framework or adapter peer requirement ship a major version so existing 1.x installations are not offered an incompatible patch release. Upgrade the related framework integrations together; native queue/bootstrap migration is documented in docs/module-workers.md.

### Patch Changes

- Updated dependencies [a2d2692]
- Updated dependencies [b99d71a]
  - @velajs/tenant@2.0.0
  - @velajs/vela@2.0.0

## 1.24.0

### Minor Changes

- fe7587f: Add Standard Schema validation and operation contracts, authoritative tenant admission and audited persistence, optional Cedar authorization with exact query plans, and Web Crypto envelope/field/file encryption. Complete compound CRUD identifiers, parent scopes, structured predicates, signed cursors, page projections and post-commit delivery. Add transactional memory and Durable Object SQLite adapters, with D1/Workers and PostgreSQL conformance coverage.

### Patch Changes

- Updated dependencies [fe7587f]
  - @velajs/vela@1.24.0
  - @velajs/tenant@1.24.0

## Unreleased

- Add the portable edge capability and optional integrations described in the package README.
