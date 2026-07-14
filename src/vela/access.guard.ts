import {
  Inject,
  Injectable,
  REQUEST_CONTEXT,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
  type RequestContext,
} from '@velajs/vela';
import type { ResolvedIdentity, ResolveIdentity } from '../types';
import {
  ACCESS_EXP_KEY,
  ACCESS_IDENTITY_KEY,
  ACCESS_MODULE_OPTIONS,
  ACCESS_RESOLVER,
  BETTER_AUTH_USER_KEY,
  type CloudflareAccessModuleOptions,
} from './tokens';

/** The per-request DI container, reached via the Hono context. */
interface ContainerLike {
  resolve<T>(token: unknown): T;
}

/** The minimal Hono-context surface this guard touches (structural, no cast). */
interface HonoLike {
  get(key: 'container'): ContainerLike;
  set(key: string, value: unknown): void;
}

/**
 * Verifies the configured {@link ResolveIdentity} against the inbound request and
 * hands the result off to the rest of the app.
 *
 * On a verified caller it writes the identity to {@link ACCESS_IDENTITY_KEY}, the
 * credential expiry to {@link ACCESS_EXP_KEY} (the WS socket-expiry data
 * contract), and the caller id to the Hono `userId` variable the CF WebSocket
 * routing already forwards. `required` mode (default) rejects an anonymous
 * caller with `UnauthorizedException`; `optional` mode lets them pass through
 * unauthenticated. Every abnormal path fails closed.
 */
@Injectable()
export class CloudflareAccessGuard implements CanActivate {
  constructor(
    @Inject(ACCESS_RESOLVER) private readonly resolve: ResolveIdentity,
    @Inject(ACCESS_MODULE_OPTIONS) private readonly options: CloudflareAccessModuleOptions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const hono = context.getContext<HonoLike>();
    const reqCtx = hono.get('container').resolve<RequestContext>(REQUEST_CONTEXT);
    const request = context.getRequest();

    let identity: ResolvedIdentity | null;
    try {
      identity = await this.resolve(request);
    } catch (error) {
      // A reject-mode contract violation (or any resolver failure) fails closed.
      throw new UnauthorizedException(
        error instanceof Error && error.name === 'IdentityRejectedError'
          ? 'Access identity rejected'
          : 'Access authentication failed',
      );
    }

    if (identity) {
      reqCtx.set(ACCESS_IDENTITY_KEY, identity);
      const expiry = identity.expiresAtMs ?? identity.exp;
      if (expiry !== undefined) reqCtx.set(ACCESS_EXP_KEY, expiry);
      hono.set('userId', identity.userId);
      if (this.options.betterAuthInterop === true) {
        reqCtx.set(BETTER_AUTH_USER_KEY, { id: identity.userId, role: identity.groups ?? [] });
      }
      return true;
    }

    if ((this.options.mode ?? 'required') === 'optional') return true;
    throw new UnauthorizedException('Access authentication required');
  }
}
