---
'@velajs/cloudflare': minor
---

`@velajs/cloudflare` exports only the Cloudflare adapter and its platform pieces, so each framework API has one import path. It requires `@velajs/vela` with the tiered entry points and imports its seams from `@velajs/vela/module-kit`, `@velajs/vela/schedule` and the other feature subpaths.

The package now publishes one JavaScript module per source file instead of shared chunks, so a bundler drops the features a Worker never imports. A shared chunk kept every decorated class it held, so a Worker that only calls `createCloudflareWorker()` shipped the storage module with the signed-URL crypto its controller uses, the KV and feature-flag drivers and the Durable Object host; it no longer does, which takes 6,975 bytes gzipped off that minimal Worker. Entry points, exports and type declarations are unchanged.

**Behavior change:** the WebSocket gateway API is no longer re-exported from `@velajs/cloudflare`. Import it from `@velajs/vela/websocket`:

| Old import | New import | Names |
|---|---|---|
| `@velajs/cloudflare` | `@velajs/vela/websocket` | `ConnectedSocket`, `MessageBody`, `OnGatewayConnection`, `OnGatewayDisconnect`, `OnGatewayInit`, `SubscribeMessage`, `UpgradeAuthenticator`, `WebSocketGateway`, `WebSocketServer`, `WebSocketUpgradeAuthenticationContext`, `WebSocketUpgradeIdentity`, `WsClient`, `WsException`, `WsMessage`, `WsResponse`, `WsServer` |
