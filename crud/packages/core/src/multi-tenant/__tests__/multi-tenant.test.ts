import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { CrudException } from '../../envelope/errors';
import {
  multiTenant,
  type JwtPayloadEnv,
  type MultiTenantMiddlewareConfig,
  type TenantEnv,
} from '../index';

/**
 * These tests dogfood the package's own typed surface: apps are typed with
 * the exported `TenantEnv` helpers, so every `c.get(...)` is statically
 * checked — no casts. A type regression in `TenantEnv`/`multiTenant<E>` fails
 * compilation here before any consumer sees it.
 */

function appWith(options?: MultiTenantMiddlewareConfig<TenantEnv>) {
  const app = new Hono<TenantEnv>();
  app.onError((err, c) => {
    if (err instanceof CrudException) {
      return c.json(err.getResponse(), err.getStatus() as never);
    }
    throw err;
  });
  app.use('*', multiTenant<TenantEnv>({ validate: () => true, ...options }));
  app.get('/data', (c) => c.json({ tenantId: c.get('tenantId') ?? null }));
  return app;
}

describe('multiTenant', () => {
  it('resolves from the X-Tenant-ID header by default', async () => {
    const res = await appWith().request('/data', { headers: { 'X-Tenant-ID': 't1' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantId: 't1' });
  });

  it('rejects missing tenant ids with 400 TENANT_REQUIRED when required', async () => {
    const res = await appWith().request('/data');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('TENANT_REQUIRED');
  });

  it('continues without a tenant when required: false', async () => {
    const res = await appWith({ required: false }).request('/data');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantId: null });
  });

  it('resolves from a path param', async () => {
    const app = new Hono<TenantEnv>();
    app.use('/:tenantId/*', multiTenant<TenantEnv>({ source: 'path', validate: () => true }));
    app.get('/:tenantId/data', (c) => c.json({ tenantId: c.get('tenantId') }));
    const res = await app.request('/t42/data');
    expect(await res.json()).toEqual({ tenantId: 't42' });
  });

  it('resolves from a query param', async () => {
    const res = await appWith({ source: 'query' }).request('/data?tenantId=tq');
    expect(await res.json()).toEqual({ tenantId: 'tq' });
  });

  it('resolves from a jwt payload claim', async () => {
    type Env = TenantEnv & JwtPayloadEnv;
    const app = new Hono<Env>();
    app.use('*', async (c, next) => {
      c.set('jwtPayload', { org_id: 'org-9' });
      await next();
    });
    app.use('*', multiTenant<Env>({ source: 'jwt', jwtClaim: 'org_id' }));
    app.get('/data', (c) => c.json({ tenantId: c.get('tenantId') }));
    const res = await app.request('/data');
    expect(await res.json()).toEqual({ tenantId: 'org-9' });
  });

  it('resolves via a custom extractor and honors contextKey', async () => {
    type Env = TenantEnv<'organizationId'>;
    const app = new Hono<Env>();
    app.use(
      '*',
      multiTenant<Env>({
        source: 'custom',
        extractor: (c) => c.req.header('X-Org') ?? undefined,
        contextKey: 'organizationId',
        validate: () => true,
      }),
    );
    app.get('/data', (c) => c.json({ org: c.get('organizationId') }));
    const res = await app.request('/data', { headers: { 'X-Org': 'o1' } });
    expect(await res.json()).toEqual({ org: 'o1' });
  });

  it('throws at setup when custom source has no extractor', () => {
    expect(() => multiTenant({ source: 'custom' })).toThrowError(/requires an `extractor`/);
  });

  it.each(['header', 'path', 'query', 'custom'] as const)(
    'requires authorization for a client-selected %s tenant source',
    (source) => {
      expect(() =>
        multiTenant({ source, ...(source === 'custom' ? { extractor: () => 'tenant' } : {}) }),
      ).toThrowError(/requires a `validate` membership check/);
    },
  );

  it('rejects invalid tenants with 400 INVALID_TENANT via validate', async () => {
    const res = await appWith({ validate: (id) => id === 'good' }).request('/data', {
      headers: { 'X-Tenant-ID': 'evil' },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_TENANT');
  });

  it('uses onMissing when provided', async () => {
    const res = await appWith({
      onMissing: (c) => c.json({ redirect: '/pick-tenant' }, 428),
    }).request('/data');
    expect(res.status).toBe(428);
    expect(await res.json()).toEqual({ redirect: '/pick-tenant' });
  });
});
