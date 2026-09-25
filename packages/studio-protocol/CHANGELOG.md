# @velajs/studio-protocol

## 1.26.0

### Minor Changes

- 3cc469d: Preserve native Flagship evaluation reasons, variants and error codes through optional driver detail methods and Studio responses. Value-only providers now report UNKNOWN instead of STATIC; native context accepts only scalar attributes, and route guards deny all evaluation errors. Existing object-validation callback signatures are unchanged.
  
  Add the optional crypto/cloudflare SecretsStoreKeyProvider for immutable, versioned AES-KW key material, with explicit per-instance caching, refresh, retry and rotation using retained decryption keys. Secrets Store supplies material for local Web Crypto; it is not a remote KMS.

## 1.25.0

### Minor Changes

- 1522c33: The Studio wire protocol moves to version 4 (`STUDIO_PROTOCOL_VERSION`): `app.modules` rows name a module's visibility flag `global` instead of `isGlobal` (`ModuleNode.global`), as `@velajs/vela` 1.32.0 names it in its module descriptions. `@velajs/studio-ui` reads `global` for the modules panel's badge. `@velajs/studio-host` changes only to ship protocol 4: it depends on the exact `@velajs/studio-protocol` release and emits a protocol-4 connection. `@velajs/studio-host` 1.24.0 declares its optional `@velajs/studio-ui` peer as `^1.25.0`, where 1.23.0 declared `^1.24.0`.
  
  **Behavior change:** there is no compatibility path for protocol 3. The UI refuses a host connection or a Studio server on another protocol version, so upgrade `@velajs/studio` 1.32.0, `@velajs/studio-host` 1.24.0 and `@velajs/studio-ui` 1.25.0 together.

## 1.24.0

### Minor Changes

- 41ec70d: Name the default provider lifetime `Scope.DEFAULT`, as Nest does.
  
  **Behavior change:** Scope.SINGLETON is renamed Scope.DEFAULT (Nest naming); no alias. Replace every `Scope.SINGLETON` with `Scope.DEFAULT`. The member's runtime value changes from `'singleton'` to `'default'`, so `getScope`, `Container.getProviderScope`, `Container.getResolvedScope`, `DiscoveryService` registrations and the conflicting-scope decorator error now report `default`. Code that compares a scope against the string `'singleton'` must compare against `Scope.DEFAULT` instead.
  
  **Behavior change:** Studio's `app.modules` provider scopes and `app.entrypoints` scopes label that lifetime `default` instead of `singleton`. `StudioProviderScope` is now `'default' | 'transient' | 'request'`, and the response validators reject `singleton`. Because an op's payload changed, `STUDIO_PROTOCOL_VERSION` is now 3 and `StudioConnection.protocolVersion` is typed as that constant. The Studio UI rejects a health probe or host connection that reports another version with its protocol-mismatch error instead of failing on the first scope label, so upgrade `@velajs/vela`, `@velajs/studio`, `@velajs/studio-ui` and `@velajs/studio-host` together.

## 1.23.0

### Minor Changes

- c5d98a7: Use the shared CRUD database resolver for Studio resources, expose qualified database/resource identities, and reject ambiguous legacy names or invalid explicit selections. Keep relation inspection and generated foreign keys within the selected database. Preserve native compiled CRUD adapters and fail before writes when time-based CDC replay would require an unavailable database-aware change source.
- 8b3ba80: Add optional application-owned structured log capture and handler completion timing through `@velajs/studio/logging`. Expose additive module ownership, effective provider scopes, and invocation metadata in Studio protocol v2 and the UI. Bound and copy log snapshots, preserve older protocol responses, and document Worker/test debugger workflows.

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

Initial coordinated release of the Studio operation catalog, capabilities and response schemas.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.
