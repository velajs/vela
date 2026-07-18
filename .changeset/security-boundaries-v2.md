---
"@velajs/vela": major
---

Harden the framework's HTTP, cache, signed-URL, storage-path, live, and WebSocket security boundaries.

- HTTP now runs guards before argument decorators and pipes, returns 400 for malformed JSON, and applies `VelaSecurityOptions`: a 1 MiB body limit plus bounded query bytes/count/depth before middleware, with narrow streaming-route overrides.
- Production and edge bootstraps emit explicit security warnings when global request/query limits are raised or disabled, a streaming limit is disabled, or WebSocket Origin isolation is opted out.
- `SecurityModule` adds exact-origin CORS, credentialed state-change Origin protection, nosniff/referrer/frame/HSTS/CSP headers, and rejects wildcard origin configuration.
- Shared response caching requires `@Cacheable()`, scopes custom keys beneath host/path/query, bypasses credentials unless a hashed principal/tenant variation is supplied, and never stores cookie-setting responses.
- Signed URLs require explicit positive expiry, method, and purpose; use a method- and purpose-separated v2 payload; and reject empty secrets or missing expiry. Existing v1 signatures are intentionally incompatible.
- Core no longer trusts forwarding headers for client identity. Trusted authentication guards can publish a framework-owned canonical principal/tenant identity, which throttling prefers before a context-aware custom tracker and the runtime-attested client address; unknown clients use a fail-closed shared bucket.
- Raw Hono 5xx messages and health-indicator payloads are no longer reflected to clients; health failures retain full non-enumerable diagnostics for structured server reporting.
- Throttler stores may return a platform-enforced allow/deny decision without fabricating an exact remaining quota; fixed backend limits fail closed when a route override does not match.
- HTTP and WebSocket execution contexts expose the declaring module ID for module-scoped authorization.
- Storage paths neutralize encoded traversal segments.
- WebSocket gateways require explicit room parameters, default browser upgrades to same-origin, reject bearer-like query credentials, authenticate cookies or bounded single-use socket tickets into canonical `{ principal, tenantId, expiresAtMs }` state before allocation, support per-delivery authorization, enforce per-gateway inbound and outbound frame/room limits across direct sends, replies, local/Redis fan-out, reject invalid room ids, and fail closed when connection setup fails. Oversized output closes with 1009 and is never written.
- WebSocket and Live identity expiry uses the explicit epoch-millisecond `expiresAtMs` field and rejects malformed or expired values. Live delivery re-runs authorization before resume and invalidation, caps sockets at 100 subscriptions and 32 rooms, caps presence metadata at 4 KiB, binds heartbeats and roster reads to transport-verified room membership, and no longer collapses distinct security callbacks into one dynamic module.
