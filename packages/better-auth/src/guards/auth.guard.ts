import {
  Inject,
  Injectable,
  Reflector,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
  type GuardPhase,
} from '@velajs/vela';
import { getTrustedContextRequest } from '@velajs/vela/module-kit';
import { getContextIdentity } from '@velajs/authz/vela';
import { BETTER_AUTH_OPTIONS } from '../better-auth.tokens';
import { BetterAuthService } from '../better-auth.service';
import type { BetterAuthRuntimeOptions } from '../better-auth.types';
import { authenticateRequest, beginAuthRequest, getAuthRequestState } from '../auth-request-state';
import { validateSessionData } from '../session-data';
import { OptionalAuth } from '../decorators/optional-auth.decorator';
import { Public } from '../decorators/public.decorator';

@Injectable()
export class AuthGuard implements CanActivate {
  /** Global guards run authentication first, then tenant, authorization and feature phases. */
  static readonly phase: GuardPhase = 'authenticate';

  constructor(
    @Inject(BetterAuthService) private readonly auth: BetterAuthService,
    @Inject(BETTER_AUTH_OPTIONS) private readonly opts: BetterAuthRuntimeOptions,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Frames trust only the authenticated connection attachment; HTTP cookies
    // and request payload never become ambient WebSocket authentication.
    if (context.getType() === 'ws') {
      if (getContextIdentity(context)) return true;
      throw new UnauthorizedException('Authentication required');
    }
    // Custom HTTP-backed dispatchers authenticate once at the outer boundary.
    // Never re-read credentials or clear shared authority across sibling fields.
    if (context.getType() !== 'http') {
      if (
        getTrustedContextRequest(context) &&
        (getAuthRequestState(context) ||
          this.reflector.getAllAndOverride(Public, context) ||
          this.reflector.getAllAndOverride(OptionalAuth, context))
      )
        return true;
      throw new UnauthorizedException('Authentication required');
    }
    beginAuthRequest(context);
    if (this.reflector.getAllAndOverride(Public, context)) return true;

    const raw = await this.auth.api.getSession({ headers: context.getRequest().headers });
    const data = validateSessionData(raw);
    if (data) {
      authenticateRequest(context, data, this.opts.issuer ?? 'better-auth');
      return true;
    }
    if (this.reflector.getAllAndOverride(OptionalAuth, context)) return true;
    throw new UnauthorizedException('Authentication required');
  }
}
