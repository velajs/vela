---
'@velajs/workflow': minor
'@velajs/agent': minor
---

Add optional Cloudflare execution and persistence subpaths. Workflow definitions now run inside existing native or Vela workflow hosts with required Standard Schema ingress validation, per-invocation authenticated dispatch injection, native terminal-error conversion, and authorized subscription streams with cancellation cleanup. Native scheduling, replay, subscriptions and deletion remain Cloudflare capabilities.

Native terminal-error conversion now preserves Cloudflare's `NonRetryableError` name; custom portable names prefix the error message instead. Replacing the native name made terminal failures retry across the native serialized error boundary.

Add a SQLite Durable Object AgentThreadStore driver with transactional scope checks, run claims, immutable completion, gap-free message deduplication, and durable approval decisions. Claims remain retained until an application safely recovers or retires them; remote effects still require idempotency.

Change AGENT_APPROVAL_EVENT_TYPE from `agent:approval` to `agent-approval` to satisfy native Cloudflare event-name rules. Update senders/listeners together and drain or separately version existing waits before changing deployments.
