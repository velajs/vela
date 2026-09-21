# @velajs/mail

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
