import { Inject, Injectable } from '@velajs/vela';
import type { UpgradeAuthenticator, WebSocketUpgradeIdentity } from '@velajs/vela/websocket';
import type { ResolveIdentity } from '../types';
import { ACCESS_RESOLVER } from './tokens';

/**
 * WebSocket upgrade authenticator for the Access token on the upgrade request:
 * `@WebSocketGateway({ authenticator: CloudflareAccessUpgradeAuthenticator })`.
 *
 * It verifies with the `CloudflareAccessModule` resolver, so the issuer,
 * audience, identity contract and tenant claim match `CloudflareAccessGuard`.
 * Upgrades always require a verified identity, whatever the module `mode`, and
 * every WebSocket identity carries a tenant: a token without the signed tenant
 * claim is refused.
 */
@Injectable()
export class CloudflareAccessUpgradeAuthenticator implements UpgradeAuthenticator {
  constructor(@Inject(ACCESS_RESOLVER) private readonly resolve: ResolveIdentity) {}

  async authenticate(request: Request): Promise<WebSocketUpgradeIdentity | false> {
    const identity = await this.resolve(request);
    if (!identity || identity.tenantId === undefined) return false;
    return {
      principal: {
        issuer: identity.issuer,
        subject: identity.subject,
        principalType: identity.principalType,
      },
      tenantId: identity.tenantId,
      expiresAtMs: identity.expiresAtMs,
    };
  }
}
