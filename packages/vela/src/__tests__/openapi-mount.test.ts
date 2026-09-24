import { describe, it, expect } from 'vitest';
import { VelaFactory, Controller, Get, Module } from '../index.js';
import { createOpenApiDocument } from '../openapi/index.js';

async function buildApp() {
  @Controller('/users')
  class UsersController {
    @Get() list() {
      return [];
    }
  }

  @Module({ controllers: [UsersController] })
  class AppModule {}

  const app = await VelaFactory.create(AppModule);
  const document = createOpenApiDocument(AppModule, { info: { title: 'T', version: '1.0.0' } });
  return { app, document };
}

describe('VelaApplication.mountOpenApi', () => {
  it('serves the JSON document at the default path /openapi.json', async () => {
    const { app, document } = await buildApp();
    app.mountOpenApi({ document });

    const res = await app.getHonoApp().request('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as typeof document;
    expect(body.openapi).toBe('3.1.0');
    expect(body.info.title).toBe('T');
    expect(body.paths['/users']).toBeDefined();
  });

  it('serves JSON at a custom path when configured', async () => {
    const { app, document } = await buildApp();
    app.mountOpenApi({ document, specPath: '/v3/api-docs' });

    const defaultRes = await app.getHonoApp().request('/openapi.json');
    expect(defaultRes.status).toBe(404);

    const customRes = await app.getHonoApp().request('/v3/api-docs');
    expect(customRes.status).toBe(200);
  });

  it('serves the Scalar UI at /scalar when ui: "scalar" is set', async () => {
    const { app, document } = await buildApp();
    app.mountOpenApi({ document, ui: 'scalar' });

    const res = await app.getHonoApp().request('/scalar');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('api-reference');
    // UI HTML must reference the JSON URL
    expect(html).toContain('data-url="/openapi.json"');
  });

  it('respects a custom UI path and JSON path together', async () => {
    const { app, document } = await buildApp();
    app.mountOpenApi({
      document,
      specPath: '/v3/api-docs',
      ui: 'scalar',
      scalarPath: '/api-docs',
    });

    const json = await app.getHonoApp().request('/v3/api-docs');
    expect(json.status).toBe(200);
    expect(json.headers.get('content-type')).toMatch(/application\/json/);

    const ui = await app.getHonoApp().request('/api-docs');
    expect(ui.status).toBe(200);
    const html = await ui.text();
    expect(html).toContain('data-url="/v3/api-docs"');
  });

  it('mounts Scalar by default when ui is omitted', async () => {
    const { app, document } = await buildApp();
    app.mountOpenApi({ document });

    // Default UI is Scalar at /scalar; the old default /docs is not used.
    const scalar = await app.getHonoApp().request('/scalar');
    expect(scalar.status).toBe(200);
    const docs = await app.getHonoApp().request('/docs');
    expect(docs.status).toBe(404);
  });

  it('returns the application instance for chaining', async () => {
    const { app, document } = await buildApp();
    const returned = app.mountOpenApi({ document });
    expect(returned).toBe(app);
  });
});
