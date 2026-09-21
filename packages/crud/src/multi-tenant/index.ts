/**
 * `@velajs/crud/multi-tenant` — tenant resolution middleware (hono-crud 0.13
 * parity). Mount it upstream of tenant-scoped resources; it publishes the
 * resolved tenant id as a context var (`c.set('tenantId', ...)`), which the
 * engine consumes for lookup scoping, list filtering, and create stamping.
 * Header, path, query, and custom selectors are not authorization by
 * themselves: configure `validate` to enforce tenant membership. The callback
 * may delegate to an upstream guard's trusted membership result, but a boolean
 * configuration switch can never turn a client selector into authority.
 *
 * `@Crud()` demands `tenantResolverMounted: true` on tenant-scoped configs
 * (see `MissingTenantResolverError`), and the engine rejects missing tenant
 * context even for direct programmatic execution.
 *
 * Generic over the Hono `Env` so typed apps keep their variable map:
 *
 * ```ts
 * const app = new Hono<TenantEnv>();
 * app.use('*', multiTenant<TenantEnv>({
 *   validate: (tenantId, ctx) => userBelongsToTenant(ctx, tenantId),
 * }));
 * app.get('/data', (c) => c.json({ tenantId: c.get('tenantId') })); // typed
 * ```
 */

import type { Context, Env, MiddlewareHandler } from 'hono';
import { CrudException } from '../envelope/errors';

/** Where the tenant id is read from. */
export type TenantIdSource = 'header' | 'path' | 'query' | 'jwt' | 'custom';

export interface MultiTenantMiddlewareConfig<E extends Env = Env> {
  /**
   * - 'header': from a request header (default `X-Tenant-ID`)
   * - 'path':   from a URL path parameter (default `:tenantId`)
   * - 'query':  from a query-string parameter (default `?tenantId=`)
   * - 'jwt':    from JWT claims (requires the JWT middleware to run first)
   * - 'custom': from the `extractor` function
   * @default 'header'
   */
  source?: TenantIdSource;
  /** @default 'X-Tenant-ID' */
  headerName?: string;
  /** @default 'tenantId' */
  pathParam?: string;
  /** @default 'tenantId' */
  queryParam?: string;
  /** JWT claim name when source is 'jwt'. @default 'tenantId' */
  jwtClaim?: string;
  /** Custom extraction (required when source is 'custom'). */
  extractor?: (ctx: Context<E>) => string | undefined | Promise<string | undefined>;
  /** Context var the tenant id is published under. @default 'tenantId' */
  contextKey?: string;
  /** Reject requests without a tenant id. @default true */
  required?: boolean;
  /** @default 'Tenant ID is required' */
  errorMessage?: string;
  /** Custom handler for missing tenant ids (instead of the 400). */
  onMissing?: (ctx: Context<E>) => Response | Promise<Response>;
  /**
   * Tenant membership validation. Required for every client-selected source
   * (`header`, `path`, `query`, and `custom`).
   */
  validate?: (tenantId: string, ctx: Context<E>) => boolean | Promise<boolean>;
  /** @default 'Invalid tenant ID' */
  invalidMessage?: string;
  /** Compatibility seam for an authoritative tenant service. Return its canonical ID. */
  admission?: { admit(selector: string, request: Request): Promise<{ readonly id: string }> };
}

/**
 * Type helper for tenant-aware Hono env types. The variable is optional
 * because it only exists after the middleware runs (and `required: false`
 * lets requests through without one).
 */
export type TenantEnv<TenantKey extends string = 'tenantId'> = {
  Variables: { [K in TenantKey]?: string };
};

/** Env published by Hono's own jwt middleware — for `source: 'jwt'` apps. */
export type JwtPayloadEnv = {
  Variables: { jwtPayload?: Record<string, unknown> };
};

export function multiTenant<E extends Env = Env>(
  options: MultiTenantMiddlewareConfig<E> = {},
): MiddlewareHandler<E> {
  const {
    source = 'header',
    headerName = 'X-Tenant-ID',
    pathParam = 'tenantId',
    queryParam = 'tenantId',
    jwtClaim = 'tenantId',
    extractor,
    contextKey = 'tenantId',
    required = true,
    errorMessage = 'Tenant ID is required',
    onMissing,
    validate,
    invalidMessage = 'Invalid tenant ID',
    admission,
  } = options;

  // `source: 'custom'` without an extractor would extract undefined on every
  // request and masquerade as a client 400 — surface the misconfiguration at
  // setup time instead.
  if (source === 'custom' && !extractor) {
    throw new Error(
      "multiTenant: source 'custom' requires an `extractor` function. Provide `extractor`, or choose a different `source`.",
    );
  }

  // A client-selected tenant id is only a selector, never proof that the
  // caller belongs to that tenant. Make the authorization boundary explicit
  // instead of shipping an insecure header default that silently trusts input.
  if (source !== 'jwt' && !validate && !admission) {
    throw new Error(
      `multiTenant: source '${source}' requires a \`validate\` membership check. ` +
        'Client-provided tenant selectors are never trusted by configuration.',
    );
  }

  const extractors: Record<
    TenantIdSource,
    (ctx: Context<E>) => string | undefined | Promise<string | undefined>
  > = {
    header: (ctx) => ctx.req.header(headerName),
    path: (ctx) => ctx.req.param(pathParam as never),
    query: (ctx) => ctx.req.query(queryParam),
    jwt: (ctx) => {
      // Hono's jwt middleware publishes the payload as `jwtPayload`. The env
      // generic can't witness a sibling middleware's variables, so this one
      // read is localized here (the public surface stays typed).
      const payload = (ctx as unknown as Context<JwtPayloadEnv>).get('jwtPayload');
      if (payload && typeof payload === 'object') {
        return payload[jwtClaim] as string | undefined;
      }
      return undefined;
    },
    custom: (ctx) => extractor?.(ctx),
  };

  return async (ctx, next) => {
    let tenantId = await extractors[source](ctx);

    if (!tenantId) {
      if (required) {
        if (onMissing) return onMissing(ctx);
        throw new CrudException(errorMessage, 400, 'TENANT_REQUIRED');
      }
      return next();
    }

    if (validate) {
      const isValid = await validate(tenantId, ctx);
      if (!isValid) {
        throw new CrudException(invalidMessage, 400, 'INVALID_TENANT');
      }
    }
    if (admission) tenantId = (await admission.admit(tenantId, ctx.req.raw)).id;

    // The key is dynamic (`contextKey`), so this one write stays untyped —
    // the PUBLIC read side is typed via `TenantEnv`.
    (ctx as Context).set(contextKey, tenantId);
    return next();
  };
}
