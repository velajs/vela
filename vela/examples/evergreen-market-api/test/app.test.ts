import { describe, expect, it } from 'vitest';
import { createEvergreenMarketApp } from '../src/app.js';

type EvergreenMarketFixture = Awaited<ReturnType<typeof createEvergreenMarketApp>>;
type EvergreenMarketOptions = Parameters<typeof createEvergreenMarketApp>[0];

async function withFixture(
  fn: (fixture: EvergreenMarketFixture) => Promise<void>,
  options?: EvergreenMarketOptions,
): Promise<void> {
  const fixture = await createEvergreenMarketApp(options);
  try {
    await fn(fixture);
  } finally {
    await fixture.app.close('test-complete');
  }
}

describe('Evergreen Market API example app', () => {
  it('covers versioned catalog CRUD, response decorators, serialization, and events', async () => {
    await withFixture(async ({ app }) => {
      const hono = app.getHonoApp();

      const listRes = await hono.request('/api/v1/catalog/items?tag=office');
      expect(listRes.status).toBe(200);
      expect(await listRes.json()).toEqual([
        { id: 1, name: 'Notebook', price: 12.5, tags: ['office'], secret: 'margin:high' },
      ]);

      const oneRes = await hono.request('/api/v1/catalog/items/1');
      expect(oneRes.status).toBe(200);
      expect(await oneRes.json()).toEqual({
        id: 1,
        name: 'Notebook',
        price: 12.5,
        tags: ['office'],
      });

      const v2Res = await hono.request('/api/v2/catalog/items/1');
      expect(v2Res.status).toBe(200);
      expect((await v2Res.json()) as object).toMatchObject({ version: 2 });

      const forbiddenCreate = await hono.request('/api/v1/catalog/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'mouse', price: 10 }),
      });
      expect(forbiddenCreate.status).toBe(403);

      const createRes = await hono.request('/api/v1/catalog/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'secret' },
        body: JSON.stringify({ name: 'mouse', price: 10 }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as { id: number; name: string; tags: string[] };
      expect(created).toMatchObject({ name: 'MOUSE', price: 10, tags: [] });

      const patchRes = await hono.request(`/api/v1/catalog/items/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-api-key': 'secret' },
        body: JSON.stringify({ price: 11 }),
      });
      expect(patchRes.status).toBe(200);
      expect((await patchRes.json()) as object).toMatchObject({ price: 11 });

      const headRes = await hono.request('/api/v1/catalog/items/1', { method: 'HEAD' });
      expect(headRes.status).toBe(200);
      expect(await headRes.text()).toBe('');

      const optionsRes = await hono.request('/api/v1/catalog/items', { method: 'OPTIONS' });
      expect(optionsRes.status).toBe(204);
      expect(optionsRes.headers.get('allow')).toContain('GET');

      const allRes = await hono.request('/api/v1/catalog/echo-method', { method: 'PATCH' });
      expect(allRes.status).toBe(200);
      expect(await allRes.json()).toEqual({ method: 'PATCH' });

      const redirectRes = await hono.request('/api/v1/catalog/redirect');
      expect(redirectRes.status).toBe(302);
      expect(redirectRes.headers.get('location')).toBe('/api/v1/catalog/items');

      const scopedDenied = await hono.request('/api/v1/catalog/scoped');
      expect(scopedDenied.status).toBe(403);

      const scopedAllowed = await hono.request('/api/v1/catalog/scoped', {
        headers: { 'x-scope': 'catalog:read' },
      });
      expect(scopedAllowed.status).toBe(200);
      expect(scopedAllowed.headers.get('x-required-scope')).toBe('catalog:read');

      const deleteRes = await hono.request(`/api/v1/catalog/items/${created.id}`, {
        method: 'DELETE',
        headers: { 'x-api-key': 'secret' },
      });
      expect(deleteRes.status).toBe(204);

      const logRes = await hono.request('/api/built-ins/event-log');
      expect((await logRes.json()) as object).toMatchObject({
        events: [{ id: created.id, name: 'MOUSE' }],
      });
    }, { cors: false });
  });

  it('covers params, built-in pipes, raw bodies, cookies, custom params, text, and SSE', async () => {
    await withFixture(async ({ app }) => {
      const hono = app.getHonoApp();
      const uuid = '550e8400-e29b-41d4-a716-446655440000';

      const paramsRes = await hono.request(
        `/api/surface/params/7/${uuid}?price=19.5&active=true&tags=a|b&mode=public&required=yes`,
        {
          headers: {
            cookie: 'session=abc; theme=dark',
            'cf-connecting-ip': '203.0.113.10',
            'x-request-id': 'req-1',
            'x-user-id': 'user-1',
          },
        },
      );
      expect(paramsRes.status).toBe(200);
      expect(await paramsRes.json()).toEqual({
        id: 7,
        uuid,
        price: 19.5,
        active: true,
        tags: ['a', 'b'],
        mode: 'public',
        required: 'yes',
        requestId: 'req-1',
        session: 'abc',
        cookies: { session: 'abc', theme: 'dark' },
        ip: '203.0.113.10',
        userId: 'user-1',
      });

      const invalidRes = await hono.request(`/api/surface/params/7/${uuid}?price=x&tags=a&mode=public`);
      expect(invalidRes.status).toBe(400);

      const bodyFieldRes = await hono.request('/api/surface/body-field', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ada', role: 'admin' }),
      });
      expect(await bodyFieldRes.json()).toEqual({
        name: 'Ada',
        body: { name: 'Ada', role: 'admin' },
      });

      const rawRes = await hono.request('/api/surface/raw', {
        method: 'POST',
        body: 'raw-payload',
      });
      expect(await rawRes.json()).toEqual({ byteLength: 11, text: 'raw-payload' });

      const responseRes = await hono.request('/api/surface/response');
      expect(responseRes.headers.get('x-response-param')).toBe('set');
      expect(await responseRes.json()).toEqual({ ok: true });

      const textRes = await hono.request('/api/surface/text');
      expect(await textRes.text()).toBe('plain text response');

      const sseRes = await hono.request('/api/surface/events');
      expect(sseRes.headers.get('content-type')).toBe('text/event-stream');
      expect(await sseRes.text()).toBe('data: example\n\n');
    });
  });

  it('covers guards, filters, interceptors, middleware, app providers, and CORS', async () => {
    await withFixture(async ({ app }) => {
      const hono = app.getHonoApp();

      const denied = await hono.request('/api/pipeline/secure');
      expect(denied.status).toBe(200);
      expect(await denied.json()).toEqual({ filteredBy: 'client-error-filter', status: 403 });

      const allowed = await hono.request('/api/pipeline/secure', {
        headers: { 'x-api-key': 'secret' },
      });
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get('x-app-interceptor')).toBe('yes');
      expect(await allowed.json()).toEqual({ data: { ok: true } });

      const appFiltered = await hono.request('/api/pipeline/app-filter');
      expect(await appFiltered.json()).toEqual({
        filteredBy: 'app-filter',
        message: 'handled globally',
      });

      const globallyBlocked = await hono.request('/api/surface/text', {
        headers: { 'x-blocked': 'true' },
      });
      expect(globallyBlocked.status).toBe(403);

      const methodMiddleware = await hono.request('/api/pipeline/method-middleware');
      expect(methodMiddleware.headers.get('x-route-middleware')).toBe('yes');

      const consumerMiddleware = await hono.request('/api/middleware');
      expect(consumerMiddleware.headers.get('x-consumer-middleware')).toBe('yes');
      expect(consumerMiddleware.headers.get('x-app-middleware')).toBe('yes');

      const corsRes = await hono.request('/api/built-ins/config', {
        headers: { origin: 'https://example.test' },
      });
      expect(corsRes.headers.get('access-control-allow-origin')).toBe('https://example.test');
    });
  });

  it('covers config, cache, events, schedule, health, HTTP client, lifecycle, throttling, and request scope', async () => {
    await withFixture(async ({ app }) => {
      const hono = app.getHonoApp();

      const configRes = await hono.request('/api/built-ins/config');
      expect(await configRes.json()).toEqual({
        name: 'evergreen-market',
        nested: true,
        fallback: 'fallback',
      });

      expect(await (await hono.request('/api/built-ins/manual-cache')).json()).toEqual({ count: 1 });
      expect(await (await hono.request('/api/built-ins/manual-cache')).json()).toEqual({ count: 2 });

      expect(await (await hono.request('/api/built-ins/cached')).json()).toEqual({ count: 1 });
      expect(await (await hono.request('/api/built-ins/cached')).json()).toEqual({ count: 1 });

      const eventRes = await hono.request('/api/built-ins/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 99, name: 'Async event' }),
      });
      expect(eventRes.status).toBe(200);
      expect(await (await hono.request('/api/built-ins/event-log')).json()).toEqual({
        events: [{ id: 99, name: 'Async event' }],
      });

      expect(await (await hono.request('/api/built-ins/schedule')).json()).toEqual({
        cron: ['hourly'],
        interval: ['poll'],
      });

      const healthRes = await hono.request('/api/built-ins/health');
      expect(healthRes.status).toBe(200);
      expect((await healthRes.json()) as object).toMatchObject({ status: 'ok' });

      expect(await (await hono.request('/api/built-ins/http')).json()).toEqual({
        status: 200,
        data: { ok: true },
      });

      expect(await (await hono.request('/api/built-ins/optional')).json()).toEqual({ optional: null });

      const firstScoped = await hono.request('/api/built-ins/request-scope');
      const secondScoped = await hono.request('/api/built-ins/request-scope');
      expect(firstScoped.headers.get('x-request-marker')).not.toBe(secondScoped.headers.get('x-request-marker'));

      const throttleOne = await hono.request('/api/built-ins/throttled', {
        headers: { 'x-test-client': 'limit-case' },
      });
      const throttleTwo = await hono.request('/api/built-ins/throttled', {
        headers: { 'x-test-client': 'limit-case' },
      });
      expect(throttleOne.status).toBe(200);
      expect(throttleTwo.status).toBe(429);

      expect((await hono.request('/api/built-ins/unthrottled')).status).toBe(200);
      expect((await hono.request('/api/built-ins/unthrottled')).status).toBe(200);

      const lifecycleBefore = await hono.request('/api/built-ins/lifecycle');
      expect(await lifecycleBefore.json()).toEqual({
        events: ['module-init', 'app-bootstrap'],
      });

      await app.close('test');
      expect(await (await hono.request('/api/built-ins/lifecycle')).json()).toEqual({
        events: [
          'module-init',
          'app-bootstrap',
          'before-shutdown:test',
          'module-destroy',
          'app-shutdown:test',
        ],
      });
    });
  });

  it('serves the OpenAPI contract generated from the example module', async () => {
    await withFixture(async ({ app, document }) => {
      expect(document.paths['/api/catalog/items']?.get?.operationId).toBe('listProducts');
      expect(document.components?.schemas?.PublicProductDto).toBeDefined();

      const res = await app.getHonoApp().request('/openapi.json');
      expect(res.status).toBe(200);
      expect((await res.json()) as object).toMatchObject({
        openapi: '3.1.0',
        info: { title: 'Evergreen Market API', version: '1.0.0' },
      });
    });
  });
});
