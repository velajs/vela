---
'@velajs/vela': minor
---

Add optional application-owned structured logging with typed immutable records,
bounded serialization, Error causes, redaction before sinks, category thresholds,
and lifecycle-managed subscriptions and async delivery. Existing Logger and text
Writer behavior remains unchanged. Add GraphQL and RPC exception-report contexts.

Bind logging to existing invocation lifetimes with protected correlation fields,
track asynchronous sink/custom-report completion, and route default exceptions
through the configured application logger without duplicate custom reporting.
