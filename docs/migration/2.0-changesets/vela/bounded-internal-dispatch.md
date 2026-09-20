---
"@velajs/vela": minor
---

Bound internal invocations with a strongly held 30-second deadline spanning both transport and response-body reads. `InternalDispatcher.run()` now accepts per-call `timeoutMs` and `signal` options, cancels stalled bodies, preserves caller abort reasons, and reports its own deadline as a retryable `gateway_timeout` error.
