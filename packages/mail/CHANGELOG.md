# @velajs/mail

## 1.28.0

### Minor Changes

- Continue the module-based Workers APIs on the 1.x release line. Vela permits breaking changes in minor releases and does not retain compatibility layers. Upgrade the framework and integrations together for native queue dispatch, cron scheduling, RPC modules and asynchronous roots; see docs/module-workers.md.

### Patch Changes

- Updated dependencies
  - @velajs/vela@1.28.0

## 3.0.0

### Major Changes

- Publish module-based Workers on the unused 3.x stable release line. Earlier experimental 2.0.0 registry versions are immutable and do not contain this release. Upgrade the framework and integrations together; see docs/module-workers.md for queue bootstrap, native delivery, RPC modules and async root migration details.

### Patch Changes

- Updated dependencies
  - @velajs/vela@3.0.0

## 2.0.0

### Major Changes

- a2d2692: Require the Vela 2 module/runtime peer line. Packages that raise their framework or adapter peer requirement ship a major version so existing 1.x installations are not offered an incompatible patch release. Upgrade the related framework integrations together; native queue/bootstrap migration is documented in docs/module-workers.md.

### Patch Changes

- Updated dependencies [b99d71a]
  - @velajs/vela@2.0.0

## 1.0.2

### Patch Changes

- 735f7ad: Dispatch each owner-bearing inbound email entrypoint once. Preserve module
  expansion for legacy ownerless entries and reject owners outside the application.
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

## 1.0.1

### Patch Changes

- 26cea98: Move mail into the monorepo with checked Vela providers, explicit async injection
  tuples, module-owned inbound scopes and app-local queue routing. Preserve the
  portable pipeline and framework-free transports/testing exports. Reject empty
  authentication gates and malformed queued fields, snapshot inbound configuration
  and input bytes, and document the supported API and unimplemented native adapters.

## 1.0.0

### Major Changes

- 9ac1c73: Stop trusting message-supplied `Authentication-Results` by default. Inbound authentication now requires adapter-verified verdicts or an exact configured `authserv-id`; the configuration-only internal bypass is removed, result clauses are parsed without scanning quoted text, and authentication headers are quarantined from the public header map. Add secure message, body, header, and recipient ceilings across direct and queue delivery, and reject custom headers reserved for the mailer, transport, or receiving MTA.

  Key dynamic mail registrations by transport, renderer, gate, policy, and async-factory identity. Distinct equal-looking tenant configurations no longer deduplicate into the first registration, explicit-key rebinding is rejected, and multiple app-global inbound gates fail closed.

## 0.1.0

- Initial release.
