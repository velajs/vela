import {
  Inject,
  Injectable,
  REQUEST_CONTEXT,
  Reflector,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
  type RequestContext,
} from '@velajs/vela';
import { AUTH_SESSION_KEY, AUTH_USER_KEY, BETTER_AUTH_OPTIONS } from '../better-auth.tokens';
import { BetterAuthService } from '../better-auth.service';
import type { BetterAuthModuleOptions } from '../better-auth.types';
import { OptionalAuth } from '../decorators/optional-auth.decorator';
import { Public } from '../decorators/public.decorator';

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly reflector = new Reflector();

  constructor(
    // Inject BetterAuthService rather than the raw better-auth instance.
    // The service's lazy `.auth` getter defers construction to first use, so
    // forRootAsync factories that depend on values only available at
    // request time (Cloudflare D1/KV bindings, etc.) build safely on the
    // first canActivate — not at module-load bootstrap.
    @Inject(BetterAuthService) private readonly auth: BetterAuthService,
    @Inject(BETTER_AUTH_OPTIONS) private readonly opts: BetterAuthModuleOptions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride(Public, context)) return true;

    const request = context.getRequest();
    const path = new URL(request.url).pathname;
    const basePath = this.opts.basePath ?? '/api/auth';
    if (path === basePath || path.startsWith(`${basePath}/`)) return true;

    const data = await this.auth.api.getSession({ headers: request.headers });

    if (data) {
      const reqCtx = resolveRequestContext(context);
      reqCtx.set(AUTH_USER_KEY, data.user);
      reqCtx.set(AUTH_SESSION_KEY, data.session);
      return true;
    }

    if (
      this.opts.defaultPolicy === 'allow' ||
      this.reflector.getAllAndOverride(OptionalAuth, context)
    ) {
      return true;
    }

    throw new UnauthorizedException('Authentication required');
  }
}

interface ContainerLike {
  resolve<T>(token: unknown): T;
}

function resolveRequestContext(context: ExecutionContext): RequestContext {
  const honoCtx = context.getContext() as { get: (k: string) => ContainerLike };
  const container = honoCtx.get('container');
  return container.resolve<RequestContext>(REQUEST_CONTEXT);
}
