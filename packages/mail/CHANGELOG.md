# @velajs/mail

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
