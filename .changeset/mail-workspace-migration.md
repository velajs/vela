---
"@velajs/mail": patch
---

Move mail into the monorepo with checked Vela providers, explicit async injection
tuples, module-owned inbound scopes and app-local queue routing. Preserve the
portable pipeline and framework-free transports/testing exports. Reject empty
authentication gates and malformed queued fields, snapshot inbound configuration
and input bytes, and document the supported API and unimplemented native adapters.
