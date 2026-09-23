---
"@velajs/better-auth": minor
---

Add `BetterAuthUpgradeAuthenticator` for `@WebSocketGateway({ authenticator: BetterAuthUpgradeAuthenticator })`. It reads the session cookie through the module's `BetterAuthService`, validates the full session, and issues a WebSocket identity under the `BetterAuthModule` issuer, as `AuthGuard` does for HTTP, expiring with the session. The tenant is the session's active organization; provide `BETTER_AUTH_UPGRADE_TENANT` in the module that declares the gateway to choose it per connection (`(session, context, request) => tenantId | undefined`). Without a tenant, the upgrade is refused.
