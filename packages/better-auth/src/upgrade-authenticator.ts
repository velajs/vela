import { Inject, Injectable, InjectionToken, Optional } from '@velajs/vela';
import type {
  UpgradeAuthenticator,
  WebSocketUpgradeAuthenticationContext,
  WebSocketUpgradeIdentity,
} from '@velajs/vela/websocket';
import { BetterAuthService } from './better-auth.service';
import { BETTER_AUTH_OPTIONS } from './better-auth.tokens';
import type { BetterAuthRuntimeOptions, Session, User } from './better-auth.types';
import { validateSessionData } from './session-data';

/** The validated Better Auth session behind a WebSocket upgrade. */
export interface BetterAuthUpgradeSession {
  readonly user: User;
  readonly session: Session;
}

/**
 * Chooses the tenant a WebSocket connection joins. Returning no tenant (or
 * throwing) refuses the upgrade.
 */
export type BetterAuthUpgradeTenantResolver = (
  session: BetterAuthUpgradeSession,
  context: WebSocketUpgradeAuthenticationContext,
  request: Request,
) => string | undefined | Promise<string | undefined>;

/**
 * Optional tenant resolver for {@link BetterAuthUpgradeAuthenticator}. Provide it
 * in the module that declares the gateway; without one, the session's active
 * organization is the tenant.
 */
export const BETTER_AUTH_UPGRADE_TENANT = new InjectionToken<BetterAuthUpgradeTenantResolver>(
  'vela.better-auth.UpgradeTenant',
);

/**
 * WebSocket upgrade authenticator backed by the Better Auth session cookie:
 * `@WebSocketGateway({ authenticator: BetterAuthUpgradeAuthenticator })`.
 *
 * The principal uses the `BetterAuthModule` issuer, as `AuthGuard` does for
 * HTTP. The identity expires with the session. Every WebSocket identity carries
 * a tenant, so a session without an active organization is refused unless a
 * {@link BETTER_AUTH_UPGRADE_TENANT} resolver supplies one.
 */
@Injectable()
export class BetterAuthUpgradeAuthenticator implements UpgradeAuthenticator {
  constructor(
    @Inject(BetterAuthService) private readonly auth: BetterAuthService,
    @Inject(BETTER_AUTH_OPTIONS) private readonly options: BetterAuthRuntimeOptions,
    @Optional()
    @Inject(BETTER_AUTH_UPGRADE_TENANT)
    private readonly resolveTenant?: BetterAuthUpgradeTenantResolver,
  ) {}

  async authenticate(
    request: Request,
    context: WebSocketUpgradeAuthenticationContext,
  ): Promise<WebSocketUpgradeIdentity | false> {
    const data = validateSessionData(await this.auth.api.getSession({ headers: request.headers }));
    if (!data) return false;
    const tenantId = this.resolveTenant
      ? await this.resolveTenant({ user: data.user, session: data.session }, context, request)
      : data.tenantId;
    if (typeof tenantId !== 'string' || tenantId.length === 0) return false;
    return {
      principal: {
        issuer: this.options.issuer ?? 'better-auth',
        subject: data.user.id,
        principalType: 'user',
      },
      tenantId,
      expiresAtMs: data.session.expiresAt.getTime(),
    };
  }
}
