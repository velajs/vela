import {
  Inject,
  Injectable,
  REQUEST_CONTEXT,
  Reflector,
  UnauthorizedException,
  clearTrustedRequestIdentity,
  setTrustedRequestIdentity,
  type CanActivate,
  type ExecutionContext,
  type RequestContext,
} from '@velajs/vela';
import {
  AUTH_ISSUER_KEY,
  AUTH_PRINCIPAL_TYPE_KEY,
  AUTH_SESSION_KEY,
  AUTH_USER_KEY,
  BETTER_AUTH_OPTIONS,
} from '../better-auth.tokens';
import { BetterAuthService } from '../better-auth.service';
import type { BetterAuthModuleOptions, Session, User } from '../better-auth.types';
import {
  authenticateRequest,
  beginAuthRequest,
  type AuthRequestState,
} from '../auth-request-state';
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
    // WebSocket upgrades are authenticated before allocation. Frames reuse
    // only that normalized attachment identity; never call HTTP-only context
    // accessors or re-read ambient cookies after the connection is established.
    if (context.getType() === 'ws') {
      if (hasValidWebSocketIdentity(context)) return true;
      throw new AuthenticationRequiredException();
    }

    // The guard owns this request's identity epoch. Clear first so public,
    // optional, malformed, and throwing auth paths can never inherit state.
    beginAuthRequest(context);
    mirrorRequestContext(context, { authenticated: false });

    if (this.reflector.getAllAndOverride(Public, context)) return true;

    const request = context.getRequest();
    const raw = await this.auth.api.getSession({ headers: request.headers });
    const data = validateSessionData(raw);

    if (data) {
      const state = authenticateRequest(context, {
        user: data.user,
        session: data.session,
        issuer: this.opts.issuer ?? 'better-auth',
        principalType: 'user',
      });
      mirrorRequestContext(context, state);
      return true;
    }

    if (this.reflector.getAllAndOverride(OptionalAuth, context)) {
      return true;
    }

    throw new AuthenticationRequiredException();
  }
}

function hasValidWebSocketIdentity(context: ExecutionContext): boolean {
  try {
    const client = context.switchToWs().getClient<{ data?: unknown }>();
    const data = client?.data;
    if (!data || typeof data !== 'object') return false;
    const record = data as Record<string, unknown>;
    const principal = record.principal;
    if (!principal || typeof principal !== 'object') return false;
    const fields = principal as Record<string, unknown>;
    return (
      typeof fields.issuer === 'string' &&
      fields.issuer.length > 0 &&
      typeof fields.subject === 'string' &&
      fields.subject.length > 0 &&
      (fields.principalType === 'user' || fields.principalType === 'service') &&
      typeof record.tenantId === 'string' &&
      record.tenantId.length > 0 &&
      typeof record.expiresAtMs === 'number' &&
      Number.isSafeInteger(record.expiresAtMs) &&
      record.expiresAtMs > Date.now()
    );
  } catch {
    return false;
  }
}

interface ContainerLike {
  resolve<T>(token: unknown): T;
}

/**
 * Preserve the public REQUEST_CONTEXT symbols for applications that consume
 * them directly. The private Request-keyed state above remains canonical: a
 * missing/duplicated framework token must not prevent a verified guard from
 * publishing identity to its own downstream decorators and guards.
 */
function mirrorRequestContext(context: ExecutionContext, state: AuthRequestState): void {
  const request = context.getRequest();
  if (!state.authenticated) {
    clearTrustedRequestIdentity(request);
  } else {
    const tenantId = readActiveOrganizationId(state.session);
    setTrustedRequestIdentity(request, {
      principal: {
        issuer: state.issuer,
        subject: state.user.id,
        principalType: state.principalType,
      },
      ...(tenantId === undefined ? {} : { tenantId }),
    });
  }

  const honoCtx = context.getContext() as { get: (k: string) => ContainerLike | undefined };
  const container = honoCtx.get('container');
  if (!container) return;

  let reqCtx: RequestContext;
  try {
    reqCtx = container.resolve<RequestContext>(REQUEST_CONTEXT);
  } catch {
    return;
  }

  if (!state.authenticated) {
    reqCtx.set<User | undefined>(AUTH_USER_KEY, undefined);
    reqCtx.set<Session | undefined>(AUTH_SESSION_KEY, undefined);
    reqCtx.set<string | undefined>(AUTH_ISSUER_KEY, undefined);
    reqCtx.set<'user' | undefined>(AUTH_PRINCIPAL_TYPE_KEY, undefined);
    return;
  }

  reqCtx.set(AUTH_USER_KEY, state.user);
  reqCtx.set(AUTH_SESSION_KEY, state.session);
  reqCtx.set(AUTH_ISSUER_KEY, state.issuer);
  reqCtx.set(AUTH_PRINCIPAL_TYPE_KEY, state.principalType);
}

function readActiveOrganizationId(session: Session): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(session, 'activeOrganizationId');
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  const value: unknown = descriptor.value;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

interface SessionData {
  user: User;
  session: Session;
}

/** A test/provider override is trusted code, but its runtime result is not. */
function validateSessionData(value: unknown): SessionData | undefined {
  if (value === null || typeof value !== 'object') return undefined;

  try {
    const userDescriptor = Object.getOwnPropertyDescriptor(value, 'user');
    const sessionDescriptor = Object.getOwnPropertyDescriptor(value, 'session');
    if (
      userDescriptor === undefined ||
      !('value' in userDescriptor) ||
      sessionDescriptor === undefined ||
      !('value' in sessionDescriptor)
    ) {
      return undefined;
    }

    const user: unknown = userDescriptor.value;
    const session: unknown = sessionDescriptor.value;
    if (
      user === null ||
      typeof user !== 'object' ||
      session === null ||
      typeof session !== 'object'
    ) {
      return undefined;
    }

    const userIdDescriptor = Object.getOwnPropertyDescriptor(user, 'id');
    const sessionIdDescriptor = Object.getOwnPropertyDescriptor(session, 'id');
    const sessionUserIdDescriptor = Object.getOwnPropertyDescriptor(session, 'userId');
    const userId =
      userIdDescriptor !== undefined && 'value' in userIdDescriptor
        ? userIdDescriptor.value
        : undefined;
    const sessionId =
      sessionIdDescriptor !== undefined && 'value' in sessionIdDescriptor
        ? sessionIdDescriptor.value
        : undefined;
    const sessionUserId =
      sessionUserIdDescriptor !== undefined && 'value' in sessionUserIdDescriptor
        ? sessionUserIdDescriptor.value
        : undefined;

    if (
      typeof userId !== 'string' ||
      userId.length === 0 ||
      typeof sessionId !== 'string' ||
      sessionId.length === 0 ||
      sessionUserId !== userId
    ) {
      return undefined;
    }

    // The identity-bearing fields above are validated as own data properties.
    // Remaining Better Auth/plugin fields stay intact for typed consumers.
    return { user: user as User, session: session as Session };
  } catch {
    return undefined;
  }
}

/**
 * `UnauthorizedException` preserves Nest-style direct behavior. The structural
 * VelaError brand also survives test/runtime package duplication, so the
 * central renderer still maps this to 401 rather than treating it as a foreign
 * 500 error.
 */
class AuthenticationRequiredException extends UnauthorizedException {
  readonly type = 'VelaError' as const;
  readonly code = 'unauthorized';
  readonly status = 401;

  constructor() {
    super('Authentication required');
  }
}
