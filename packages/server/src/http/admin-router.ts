/**
 * Mounts the reserved admin surface onto the app's Hono instance. Middleware
 * order per route: bearer auth → per-IP rate limit → dispatch. Default-closed:
 * with no token configured, `health` reports `{ enabled: false }` and every
 * other route 404s `STUDIO_DISABLED` (existence-hiding).
 */
import type { Context, Hono } from 'hono';
import type { Container, RouteContributorContext } from '@velajs/vela';
import {
  STUDIO_HEALTH_SUFFIX,
  STUDIO_PROTOCOL_VERSION,
  STUDIO_RPC_SUFFIX,
  STUDIO_TOKEN_HEADER,
  STUDIO_WS_TOKEN_SUFFIX,
} from '@velajs/studio-protocol';
import type { AdminRpcRequest, StudioErrorCode } from '@velajs/studio-protocol';
import { STUDIO_RESOLVED_CONFIG } from '../tokens';
import type { AdminOpContext, AdminPrincipal, ResolvedStudioConfig } from '../studio.types';
import { studioError, toAdminErrorBody } from '../studio.errors';
import { StudioDispatchRegistry } from '../rpc/dispatch.registry';
import { AdminSubTokenSigner } from '../security/sub-token.signer';
import { timingSafeEqual } from '../security/token-compare';
import { RateLimiter } from './middleware/rate-limit';

function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  });
}

/** Build a redacted error envelope (`op` included when the failure is op-scoped). */
function errorEnvelope(code: StudioErrorCode, op?: string): Response {
  const { body, status } = toAdminErrorBody(studioError(code));
  return jsonResponse(
    op !== undefined ? { ok: false, op, error: body, status } : { ok: false, error: body, status },
    status,
  );
}

function clientIp(c: Context): string | null {
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0]?.trim() ?? null;
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-real-ip') ?? null;
}

/** Constant-time bearer check. Returns the principal or null. */
async function authenticate(
  c: Context,
  config: ResolvedStudioConfig,
): Promise<AdminPrincipal | null> {
  const header = c.req.header(STUDIO_TOKEN_HEADER);
  if (!header || !config.token) return null;
  if (header.slice(0, 7).toLowerCase() !== 'bearer ') return null;
  const presented = header.slice(7);
  if (!(await timingSafeEqual(presented, config.token))) return null;
  return { subject: 'master', via: 'master-token', ip: clientIp(c) };
}

async function readBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const parsed = await c.req.json();
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Register the admin routes. Called by the route contributor's `buildRoutes`. */
export function mountAdminRouter(app: Hono, ctx: RouteContributorContext): void {
  const container = ctx.container;
  const config = container.resolve(STUDIO_RESOLVED_CONFIG);
  const base = config.absolute ? config.path : ctx.joinPaths(ctx.globalPrefix, config.path);

  const healthPath = ctx.joinPaths(base, STUDIO_HEALTH_SUFFIX);
  const rpcPath = ctx.joinPaths(base, `${STUDIO_RPC_SUFFIX}:op`);
  const wsTokenPath = ctx.joinPaths(base, STUDIO_WS_TOKEN_SUFFIX);

  const rateLimiter = config.rateLimit ? new RateLimiter(config.rateLimit) : null;

  // Health is always reachable (never existence-hidden): it is how a client
  // learns Studio is disabled.
  app.get(healthPath, () =>
    jsonResponse({ enabled: config.enabled, protocolVersion: STUDIO_PROTOCOL_VERSION }, 200),
  );

  // Shared pre-dispatch chain: default-closed → auth → rate limit.
  const guard = async (
    c: Context,
    op?: string,
  ): Promise<{ principal: AdminPrincipal } | { response: Response }> => {
    if (!config.enabled) return { response: errorEnvelope('STUDIO_DISABLED', op) };
    const principal = await authenticate(c, config);
    if (!principal) return { response: errorEnvelope('STUDIO_UNAUTHORIZED', op) };
    if (rateLimiter && !rateLimiter.check(principal.ip ?? 'unknown')) {
      return { response: errorEnvelope('STUDIO_RATE_LIMITED', op) };
    }
    return { principal };
  };

  app.post(rpcPath, async (c) => {
    const op = c.req.param('op') ?? '';
    const gated = await guard(c, op);
    if ('response' in gated) return gated.response;

    const body = await readBody(c);
    const request: AdminRpcRequest = { args: body.args };
    const registry = container.resolve(StudioDispatchRegistry);
    const opCtx = buildOpContext(c, gated.principal, config, container);
    const result = await registry.dispatch(op, request, opCtx);
    return jsonResponse(result, result.ok ? 200 : result.status);
  });

  app.post(wsTokenPath, async (c) => {
    const gated = await guard(c);
    if ('response' in gated) return gated.response;

    const body = await readBody(c);
    const room = typeof body.room === 'string' ? body.room : undefined;
    const signer = container.resolve(AdminSubTokenSigner);
    const { token, exp } = await signer.mint({
      scope: 'live',
      ...(room !== undefined ? { room } : {}),
    });
    return jsonResponse({ token, exp }, 200);
  });
}

function buildOpContext(
  c: Context,
  principal: AdminPrincipal,
  config: ResolvedStudioConfig,
  container: Container,
): AdminOpContext {
  return {
    http: c,
    admin: principal,
    editable: config.editable,
    audit: () => {},
    get: (token) => container.resolve(token),
  };
}
