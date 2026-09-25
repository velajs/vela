/**
 * Mounts the reserved admin surface onto the app's Hono instance. Middleware
 * order per route: bearer auth → per-IP rate limit → dispatch. Default-closed:
 * with no token configured, `health` reports `{ enabled: false }` and every
 * other route 404s `STUDIO_DISABLED` (existence-hiding).
 */
import { UnsupportedMediaTypeException } from '@velajs/vela';
import { readJsonBody } from '@velajs/vela/module-kit';
import type { VelaContext as Context, VelaHono as Hono } from '@velajs/vela';
import type { Container, RouteContributorContext } from '@velajs/vela/module-kit';
import {
  STUDIO_EXPORT_SUFFIX,
  STUDIO_HEALTH_SUFFIX,
  STUDIO_PROTOCOL_VERSION,
  STUDIO_RPC_SUFFIX,
  STUDIO_TOKEN_HEADER,
  STUDIO_WS_TOKEN_SUFFIX,
} from '@velajs/studio-protocol';
import type { AdminRpcRequest, StudioErrorCode } from '@velajs/studio-protocol';
import { STUDIO_RESOLVED_CONFIG } from '../tokens';
import type { AdminOpContext, AdminPrincipal, ResolvedStudioConfig } from '../studio.types';
import { studioError, studioUnsupportedMediaType, toAdminErrorBody } from '../studio.errors';
import { StudioDispatchRegistry } from '../rpc/dispatch.registry';
import { AdminSubTokenSigner } from '../security/sub-token.signer';
import { timingSafeEqual } from '../security/token-compare';
import { STUDIO_MODEL_SOURCE } from '../data/model-source.port';
import { TIME_TRAVEL_PORT } from '../timetravel/port.token';
import { streamAllModelsNdjson, streamModelNdjson } from '../transfer/transfer.ops';
import { FixedWindowCounter, RateLimiter } from './middleware/rate-limit';
import { declaringModuleId } from './studio-scope';

/**
 * Stable pseudo-op identifier stamped onto the `/ws-token` endpoint's
 * pre-dispatch error envelope. `/ws-token` is NOT an `@AdminRpc` op, but the
 * protocol's error branch ({@link AdminRpcResponse} `ok: false`) requires an
 * `op: string`; this constant fills that slot so the endpoint never emits an
 * undeclared wire shape. It is deliberately NOT a member of `STUDIO_OPS`.
 */
const WS_TOKEN_PSEUDO_OP = 'studio.wsToken';

/** Pseudo-op stamped onto the `/export` route's pre-stream error envelope (see {@link WS_TOKEN_PSEUDO_OP}). */
const EXPORT_PSEUDO_OP = 'transfer.export';

/**
 * Pre-auth throttle ceiling as a multiple of the post-auth `max`. Generous by
 * design: the fixed-window counter only exists to blunt unauthenticated floods,
 * never to constrain a legitimate authenticated caller (whom the post-auth token
 * bucket governs).
 */
const PRE_AUTH_MULTIPLIER = 5;

function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  });
}

/** Build a redacted, op-scoped error envelope (matches the {@link AdminRpcResponse} error branch). */
function errorEnvelope(code: StudioErrorCode, op: string): Response {
  const { body, status } = toAdminErrorBody(studioError(code));
  return jsonResponse({ ok: false, op, error: body, status }, status);
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

/**
 * The JSON request body as an object; `{}` when absent, malformed or not an
 * object. A body under a non-JSON media type gets the 415 envelope instead, so
 * a form-style cross-site POST never reaches an admin op.
 */
async function readBody(c: Context, op: string): Promise<Record<string, unknown> | Response> {
  let parsed: unknown;
  try {
    parsed = await readJsonBody(c);
  } catch (error) {
    if (!(error instanceof UnsupportedMediaTypeException)) return {};
    const { body, status } = toAdminErrorBody(studioUnsupportedMediaType(error.message));
    return jsonResponse({ ok: false, op, error: body, status }, status);
  }
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
}

/** Register the admin routes. Called by the route contributor's `buildRoutes`. */
export function mountAdminRouter(app: Hono, ctx: RouteContributorContext): void {
  const container = ctx.container;
  // Studio's own tokens, read in the scope of the StudioModule declaring the
  // claimed controller, never another module's registration of them.
  const studio = declaringModuleId(container, ctx.controller);
  const config = container.resolve(STUDIO_RESOLVED_CONFIG, studio);
  const base = config.absolute ? config.path : ctx.joinPaths(ctx.globalPrefix, config.path);

  const healthPath = ctx.joinPaths(base, STUDIO_HEALTH_SUFFIX);
  const rpcPath = ctx.joinPaths(base, `${STUDIO_RPC_SUFFIX}:op`);
  const wsTokenPath = ctx.joinPaths(base, STUDIO_WS_TOKEN_SUFFIX);
  const exportPath = ctx.joinPaths(base, STUDIO_EXPORT_SUFFIX);

  // Post-auth token bucket (per authenticated principal IP).
  const rateLimiter = config.rateLimit ? new RateLimiter(config.rateLimit) : null;
  // Pre-auth fixed-window counter (per client IP), 5× the post-auth ceiling.
  const preAuthCounter = config.rateLimit
    ? new FixedWindowCounter({
        windowMs: config.rateLimit.windowMs,
        max: config.rateLimit.max * PRE_AUTH_MULTIPLIER,
      })
    : null;

  // Health is always reachable (never existence-hidden): it is how a client
  // learns Studio is disabled.
  app.get(healthPath, () =>
    jsonResponse({ enabled: config.enabled, protocolVersion: STUDIO_PROTOCOL_VERSION }, 200),
  );

  // Shared pre-dispatch chain: default-closed → pre-auth throttle → auth →
  // post-auth rate limit. The pre-auth throttle runs BEFORE the bearer check so
  // an unauthenticated flood cannot force a constant-time compare per request.
  const guard = async (
    c: Context,
    op: string,
  ): Promise<{ principal: AdminPrincipal } | { response: Response }> => {
    if (!config.enabled) return { response: errorEnvelope('STUDIO_DISABLED', op) };
    if (preAuthCounter && !preAuthCounter.check(clientIp(c) ?? 'unknown')) {
      return { response: errorEnvelope('STUDIO_RATE_LIMITED', op) };
    }
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

    const body = await readBody(c, op);
    if (body instanceof Response) return body;
    const request: AdminRpcRequest = { args: body.args };
    const registry = container.resolve(StudioDispatchRegistry, studio);
    const opCtx = buildOpContext(c, gated.principal, config, container);
    const result = await registry.dispatch(op, request, opCtx);
    return jsonResponse(result, result.ok ? 200 : result.status);
  });

  app.post(wsTokenPath, async (c) => {
    const gated = await guard(c, WS_TOKEN_PSEUDO_OP);
    if ('response' in gated) return gated.response;

    const body = await readBody(c, WS_TOKEN_PSEUDO_OP);
    if (body instanceof Response) return body;
    const room = typeof body.room === 'string' ? body.room : undefined;
    const signer = container.resolve(AdminSubTokenSigner, studio);
    const { token, exp } = await signer.mint({
      scope: 'live',
      ...(room !== undefined ? { room } : {}),
    });
    return jsonResponse({ token, exp }, 200);
  });

  // `GET {base}/export` — the transfer/snapshot NDJSON stream. Behind the SAME
  // bearer + rate-limit chain as the RPC surface (a read of admin-visible data,
  // so no editable gate). Query: `?model=<name>` (one model), `?mark=<id>` (a
  // snapshot via the bound time-travel port), or neither (every managed model).
  app.get(exportPath, async (c) => {
    const gated = await guard(c, EXPORT_PSEUDO_OP);
    if ('response' in gated) return gated.response;
    try {
      const stream = await exportStream(c, container);
      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'application/x-ndjson; charset=UTF-8',
          'content-disposition': 'attachment; filename="studio-export.ndjson"',
        },
      });
    } catch (error) {
      const { body, status } = toAdminErrorBody(error);
      return jsonResponse({ ok: false, op: EXPORT_PSEUDO_OP, error: body, status }, status);
    }
  });
}

/**
 * Resolve the NDJSON export stream for a `GET {base}/export` request. `mark`
 * takes precedence (a snapshot via the time-travel port's optional
 * `exportSnapshot`); otherwise `model` scopes to one model, and its absence
 * streams every managed model. Throws `FEATURE_UNCONFIGURED` when the required
 * source/port is unbound (surfaced as an error envelope, not a broken stream).
 */
async function exportStream(c: Context, container: Container): Promise<ReadableStream<Uint8Array>> {
  const mark = c.req.query('mark');
  if (mark !== undefined) {
    if (!container.has(TIME_TRAVEL_PORT)) throw studioError('TIMETRAVEL_UNAVAILABLE');
    const port = container.resolve(TIME_TRAVEL_PORT);
    if (port.exportSnapshot === undefined) {
      throw studioError(
        'FEATURE_UNCONFIGURED',
        'the bound time-travel port has no snapshot export',
      );
    }
    return port.exportSnapshot(mark);
  }
  if (!container.has(STUDIO_MODEL_SOURCE)) throw studioError('FEATURE_UNCONFIGURED');
  const source = container.resolve(STUDIO_MODEL_SOURCE);
  const model = c.req.query('model');
  // Validate a named model synchronously so an unknown model is an error
  // envelope, not a stream that throws on first pull.
  if (model !== undefined) {
    source.describe(model);
    return streamModelNdjson(source, model);
  }
  return streamAllModelsNdjson(source);
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
