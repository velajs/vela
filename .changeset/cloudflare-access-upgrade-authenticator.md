---
"@velajs/cloudflare-access": minor
---

Add `CloudflareAccessUpgradeAuthenticator` to `@velajs/cloudflare-access/vela` for `@WebSocketGateway({ authenticator: CloudflareAccessUpgradeAuthenticator })`. It verifies the Access token on the upgrade request with the `CloudflareAccessModule` resolver, so issuer, audience, identity contract and tenant claim match `CloudflareAccessGuard`. Upgrades always require a verified identity, whatever the module `mode`, and a token without the signed tenant claim is refused.
