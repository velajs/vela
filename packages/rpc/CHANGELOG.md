# @velajs/rpc

## 3.0.0

### Major Changes

- Publish module-based Workers on the unused 3.x stable release line. Earlier experimental 2.0.0 registry versions are immutable and do not contain this release. Upgrade the framework and integrations together; see docs/module-workers.md for queue bootstrap, native delivery, RPC modules and async root migration details.

### Patch Changes

- Updated dependencies
  - @velajs/vela@3.0.0

## 2.0.0

### Major Changes

- a2d2692: Require the Vela 2 module/runtime peer line. Packages that raise their framework or adapter peer requirement ship a major version so existing 1.x installations are not offered an incompatible patch release. Upgrade the related framework integrations together; native queue/bootstrap migration is documented in docs/module-workers.md.

### Minor Changes

- b99d71a: Compose native Worker applications through modules. QueueModule now initializes transport configuration at bootstrap and publishes driver-owned native routes, removing application-written consumer bridges. Duplicate queue ownership fails at startup. Cloudflare rejects deliveries without a consumer instead of silently accepting them; existing native decorators and envelopes remain supported.
  
  Cloudflare roots accept dynamic modules and asynchronous factories. RPC server modules and injectable named clients reuse the existing schema-validated dispatcher. Deployment checks validate module queue mappings, producer declarations and RPC service bindings. A four-worker example and exact-archive runtime proof cover composition, native delivery and scheduling.

### Patch Changes

- Updated dependencies [b99d71a]
  - @velajs/vela@2.0.0

## 1.1.0

### Minor Changes

- 04dba06: Add optional schema-inferred method RPC with a portable HTTP/service-binding client and a Vela server adapter. Preserve module ownership, async validation, HTTP guards and managed request lifetime; reject duplicate procedures and malformed envelopes. Include explicit exposure policy, bounded client deadlines, opt-in idempotent retries, browser isolation checks and native Workers coverage.

### Patch Changes

- 20c4895: Validate RPC route paths with linear boundary, separator and character checks, avoiding excessive regex backtracking on long invalid paths. Preserve concrete absolute paths with nonempty ASCII identifier segments and reject trailing or repeated slashes and disallowed characters.
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
