---
"@velajs/vela": minor
"@velajs/tenant": minor
"@velajs/authz": minor
"@velajs/authz-cedar": minor
"@velajs/better-auth": minor
---

Publish verified identity through the canonical execution-context APIs across HTTP adapters and native managed invocations. Identity snapshots are immutable, isolated to the exact invocation, and unavailable after expiry, clear, replacement, completion or container disposal. Tenant admission and authorization reject stale authentication snapshots after asynchronous checks.

Native tenant and Cedar guards now require canonical identity published by a verified transport adapter. Resolver output and service-binding caller props cannot substitute for authentication. WebSocket attachment support remains available. The integrations require the updated core peer version; explicitly order authentication, tenant and authorization guards on native hosts.

Update the Better Auth integration alongside its authorization dependency with the compatible core peer floor.
