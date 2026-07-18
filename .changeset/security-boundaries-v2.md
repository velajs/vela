---
"@velajs/cloudflare": major
---

Align Cloudflare adapters with Vela's hardened v2 security contracts.

- R2 proxy URLs use method/purpose-scoped signatures, carry object keys as opaque signed claims, decode exactly once, and reject malformed/non-canonical/out-of-root keys. Existing proxy URLs must be regenerated.
- R2 proxy downloads are always served as attachments with `nosniff`; attacker-controlled HTML/SVG is never rendered inline on the authenticated API origin.
- `cloudflareAdapter()` supplies only Cloudflare's platform connection address to Vela client-IP/throttling resolution; spoofable forwarding headers are ignored.
- `createCloudflareApp({ security })` forwards Vela's unified body/query limits.
- WebSocket upgrades run origin, authorization, and canonical identity authentication before Durable Object allocation; reject bearer-like query credentials; consume and strip short-lived room-bound socket tickets; strip spoofable internal headers; validate room/frame bounds; and fail closed on rejected lifecycle hooks.
- Durable Object names are scoped by the declaring gateway path plus room. `broadcastToRoom`, `liveInvalidateToRoom`, and `durableObjectLive` now require the gateway path so equal room names cannot cross gateways.
- Hibernation attachments carry an explicit pending/active/rejected lifecycle plus the gateway's validated inbound/outbound frame ceiling. Messages and fan-out reach only active sockets; expiry, revocation, and failed per-delivery guard checks close with 1008, while oversized direct, reply, or broadcast output closes with 1009 without writing the frame.
- Cloudflare Access and socket-ticket identities forward and persist canonical `{ principal, tenantId, expiresAtMs }` state; malformed, conflicting, or expired identities are rejected before allocation and on subsequent frames/live pushes.
- Initial hibernation attachments are bounded to Cloudflare's 16 KiB limit.
- Add a fail-closed Vela throttler adapter for Cloudflare's distributed Rate Limiting binding. Binding limit and period must match the route configuration; exact remaining quota is no longer fabricated.
- Inbound email forwards only the platform SMTP envelope and does not promote raw or `Headers`-derived Authentication-Results into verified verdicts.
- Release wiring requires the published Vela 2, Feature Flags 1, Mail 1, and Workflow 0.1 packages; local absolute package overrides are removed so frozen standalone CI is portable.
