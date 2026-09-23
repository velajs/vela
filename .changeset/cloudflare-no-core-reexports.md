---
'@velajs/cloudflare': minor
---

`@velajs/cloudflare` exports only the Cloudflare adapter and its platform pieces, so each framework API has one import path. It requires `@velajs/vela` with the tiered entry points and imports its seams from `@velajs/vela/module-kit`, `@velajs/vela/schedule` and the other feature subpaths.

**Behavior change:** the WebSocket gateway API is no longer re-exported from `@velajs/cloudflare`. Import it from `@velajs/vela/websocket`:

| Old import | New import | Names |
|---|---|---|
| `@velajs/cloudflare` | `@velajs/vela/websocket` | `ConnectedSocket`, `MessageBody`, `OnGatewayConnection`, `OnGatewayDisconnect`, `OnGatewayInit`, `SubscribeMessage`, `UpgradeAuthenticator`, `WebSocketGateway`, `WebSocketServer`, `WebSocketUpgradeAuthenticationContext`, `WebSocketUpgradeIdentity`, `WsClient`, `WsException`, `WsMessage`, `WsResponse`, `WsServer` |
