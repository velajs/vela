---
"@velajs/cloudflare": minor
---

**Behavior change:** a WebSocket Durable Object now refuses to start when its module registers the core `WebSocketModule` instead of `CloudflareWebSocketModule`. The core module's `WS_SERVER` broadcasts through its own sync driver, which never reaches the Durable Object's sockets, so `@WebSocketServer()` pushes were silently lost. Import `CloudflareWebSocketModule.forRoot()` in modules a `VelaWebSocketDurableObject` bootstraps.

The Worker adapter now warns once per isolate when `LiveModule` runs the default `localLive()` driver in the Worker, whose invalidations never reach subscriptions held by the Durable Object. Pass `driver: () => durableObjectLive({ namespace, gatewayPath })`. The warning respects the `'silent'` diagnostics mode.
