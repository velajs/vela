import {
  Inject,
  Injectable,
  Reflector,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@velajs/vela';
import { getContextIdentity } from '@velajs/authz/vela';
import { BETTER_AUTH_OPTIONS } from '../better-auth.tokens';
import { BetterAuthService } from '../better-auth.service';
import type { BetterAuthRuntimeOptions } from '../better-auth.types';
import { authenticateRequest, beginAuthRequest } from '../auth-request-state';
import { validateSessionData } from '../session-data';
import { OptionalAuth } from '../decorators/optional-auth.decorator';
import { Public } from '../decorators/public.decorator';

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly reflector = new Reflector();

  constructor(
    @Inject(BetterAuthService) private readonly auth: BetterAuthService,
    @Inject(BETTER_AUTH_OPTIONS) private readonly opts: BetterAuthRuntimeOptions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Frames trust only the authenticated connection attachment; HTTP cookies
    // and request payload never become ambient WebSocket authentication.
    if (context.getType() === 'ws') {
      if (getContextIdentity(context)) return true;
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
