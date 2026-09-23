---
"@velajs/vela": minor
---

**Behavior change:** `LiveModule` now fails at bootstrap when the application registers no `WsDispatcher`. Subscriptions only arrive over the `$live` WebSocket event, so without `WebSocketModule.forRoot()` (or `CloudflareWebSocketModule.forRoot()` on Cloudflare) every subscribe was dropped without an error.
