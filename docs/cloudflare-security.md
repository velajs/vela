# Cloudflare security

The adapter preserves platform identity and isolates storage and WebSocket
operations by their configured application scope.

## R2 presigned URLs

The R2 proxy route `/storage/:disk` carries the canonical full key as an opaque, signed
base64url `key` claim. The proxy verifies method/purpose/expiry before decoding
the claim exactly once, rejects malformed or non-canonical keys, and asserts the
key remains beneath the configured disk root.

Generate proxy URLs with `StorageService.url()` so the key and authorization
claims are signed together.

## Trusted client identity

`cloudflareAdapter()` supplies Vela with Hono's Cloudflare connection address,
which reads the platform `CF-Connecting-IP` signal. `X-Forwarded-For` and
`X-Real-IP` are not fallbacks. `@Ip()` and Vela's default throttler therefore use
the same platform trust boundary. The built-in throttler store remains
per-isolate; globally atomic limits require a Durable Object or Cloudflare rate
limiting adapter.

`createCloudflareApp({ security })` forwards Vela's body/query policy,
including narrow streaming route overrides.

## WebSocket identity and allocation

Upgrade origin and authorization checks run before Durable Object allocation.
Spoofable internal identity headers are stripped, Cloudflare Access identity is
propagated as issuer + subject + principal type + trusted tenant +
`expiresAtMs`, attachments and frames are bounded, and invalid/expired
identities fail closed. Authenticated upgrades without a server-derived tenant
fail closed.

A gateway's `authenticator`, an `UpgradeAuthenticator` class each application
resolves through dependency injection, accepts secure-cookie sessions or
Vela's 30-second, room-bound, single-use socket tickets. A gateway without one
refuses every upgrade. Bearer-like query
credentials and duplicate tickets are rejected. A ticket is stripped before
Durable Object forwarding, atomically consumed through a `NonceStore`, and its
canonical `{ principal, tenantId, expiresAtMs }` identity is stored in the
hibernation attachment. Use `durableObjectNonceStore()` for cross-isolate replay
protection.

Sockets persist an explicit pending/active/rejected lifecycle. Failed
`handleConnection` hooks cannot dispatch later frames, and every fan-out reruns
Vela's app-wide guards plus the gateway's optional `authorizeDelivery` hook.
A broadcast issued while a socket's `handleConnection` hook runs, such as
`server.emit()` announcing the new connection, skips that still-pending socket
and reaches the room's active sockets; the hook can still `client.send()` to the
new socket directly. A pending socket that is not being admitted is closed with
1008 when a broadcast reaches it.
The gateway's validated `maxFrameBytes` is also persisted in the hibernation
attachment. Direct sends, replies, Durable Object broadcasts, and live/sync
delivery therefore keep the same outbound ceiling after eviction; oversized
output closes that socket with 1009 without calling the native send method.

Room Durable Object names include the declaring gateway path. `Gateways`
pushes read the path, binding and room parameter from the gateway's
`@WebSocketGateway` metadata, so they always reach the object that holds the
room's sockets. Pass the exact path to
`liveInvalidateToRoom(namespace, gatewayPath, room, tags)` and
`durableObjectLive({ gatewayPath, ... })`; for a gateway without `roomParam`
both reach its one object, named by the path. The default live driver reads
the path, with the binding, from the application's single binding-backed
gateway.
