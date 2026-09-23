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
  const document = createOpenApiDocument(AppModule, {
    info: { title: 'T', version: '1.0.0' },
  });
  return { app, document };
}

describe('VelaApplication.mountOpenApi — hono-crud docs convention', () => {
  it('default (ui unset) → Scalar @ /scalar, spec @ /openapi.json', async () => {
    const { app, document } = await buildApp();
    app.mountOpenApi({ document });

    const spec = await app.getHonoApp().request('/openapi.json');
    expect(spec.status).toBe(200);
    expect(spec.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await spec.json()) as typeof document;
    expect(body.openapi).toBe('3.1.0');
    expect(body.paths['/users']).toBeDefined();

    const scalar = await app.getHonoApp().request('/scalar');
    expect(scalar.status).toBe(200);
    expect(scalar.headers.get('content-type')).toMatch(/text\/html/);
    const html = await scalar.text();
    expect(html).toContain('cdn.jsdelivr.net/npm/@scalar/api-reference');
    expect(html).toContain('data-url="/openapi.json"');
  });

  it('ui: "swagger" → Swagger UI @ /docs with CDN + spec url', async () => {
    const { app, document } = await buildApp();
    app.mountOpenApi({ document, ui: 'swagger' });

    const res = await app.getHonoApp().request('/docs');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('cdn.jsdelivr.net/npm/swagger-ui-dist/swagger-ui.css');
    expect(html).toContain('cdn.jsdelivr.net/npm/swagger-ui-dist/swagger-ui-bundle.js');
    expect(html).toContain('SwaggerUIBundle({ url: "/openapi.json"');
  });

  it('ui: "redoc" → ReDoc @ /redoc with CDN + spec-url', async () => {
    const { app, document } = await buildApp();
    app.mountOpenApi({ document, ui: 'redoc' });

    const res = await app.getHonoApp().request('/redoc');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('cdn.jsdelivr.net/npm/redoc/bundles/redoc.standalone.js');
    expect(html).toContain('spec-url="/openapi.json"');
  });

  it('ui: "all" → swagger@/docs, scalar@/scalar, redoc@/redoc, spec@/openapi.json', async () => {
    const { app, document } = await buildApp();
    app.mountOpenApi({ document, ui: 'all' });

    const [spec, swagger, scalar, redoc] = await Promise.all([
      app.getHonoApp().request('/openapi.json'),
      app.getHonoApp().request('/docs'),
      app.getHonoApp().request('/scalar'),
      app.getHonoApp().request('/redoc'),
    ]);
    expect(spec.status).toBe(200);
    expect(swagger.status).toBe(200);
    expect(scalar.status).toBe(200);
    expect(redoc.status).toBe(200);

    expect(await swagger.text()).toContain('SwaggerUIBundle');
    expect(await scalar.text()).toContain('@scalar/api-reference');
    expect(await redoc.text()).toContain('spec-url="/openapi.json"');
  });

  it('ui: ["swagger","redoc"] → only those two mounted, scalar absent (404)', async () => {
    const { app, document } = await buildApp();
    app.mountOpenApi({ document, ui: ['swagger', 'redoc'] });

    expect((await app.getHonoApp().request('/docs')).status).toBe(200);
    expect((await app.getHonoApp().request('/redoc')).status).toBe(200);
    expect((await app.getHonoApp().request('/scalar')).status).toBe(404);
  });

  it('honors custom swaggerPath / scalarPath / redocPath / specPath', async () => {
    const { app, document } = await buildApp();
    app.mountOpenApi({
      document,
      ui: 'all',
      specPath: '/spec.json',
      swaggerPath: '/sw',
      scalarPath: '/sc',
      redocPath: '/rd',
    });

    expect((await app.getHonoApp().request('/spec.json')).status).toBe(200);
    expect((await app.getHonoApp().request('/sw')).status).toBe(200);
    expect((await app.getHonoApp().request('/sc')).status).toBe(200);
    expect((await app.getHonoApp().request('/rd')).status).toBe(200);
    // Defaults must NOT be mounted when overridden.
    expect((await app.getHonoApp().request('/openapi.json')).status).toBe(404);
    expect((await app.getHonoApp().request('/docs')).status).toBe(404);
    expect((await app.getHonoApp().request('/scalar')).status).toBe(404);
    expect((await app.getHonoApp().request('/redoc')).status).toBe(404);

    const sw = await (await app.getHonoApp().request('/sw')).text();
    expect(sw).toContain('SwaggerUIBundle({ url: "/spec.json"');
  });

  it('back-compat: deprecated path + ui:"scalar" + uiPath aliases still work', async () => {
    const { app, document } = await buildApp();
    app.mountOpenApi({
      document,
      ui: 'scalar',
      uiPath: '/legacy',
      path: '/legacy.json',
    });

    const spec = await app.getHonoApp().request('/legacy.json');
    expect(spec.status).toBe(200);
    expect(spec.headers.get('content-type')).toMatch(/application\/json/);

    const ui = await app.getHonoApp().request('/legacy');
    expect(ui.status).toBe(200);
    const html = await ui.text();
    expect(html).toContain('data-url="/legacy.json"');

    // New defaults are NOT mounted when the deprecated aliases drive paths.
    expect((await app.getHonoApp().request('/scalar')).status).toBe(404);
    expect((await app.getHonoApp().request('/openapi.json')).status).toBe(404);
  });

  it('title appears in each UI HTML <title>', async () => {
    const { app, document } = await buildApp();
    app.mountOpenApi({ document, ui: 'all', title: 'My API Docs' });

    const swagger = await (await app.getHonoApp().request('/docs')).text();
    const scalar = await (await app.getHonoApp().request('/scalar')).text();
    const redoc = await (await app.getHonoApp().request('/redoc')).text();

    expect(swagger).toContain('<title>My API Docs</title>');
    expect(scalar).toContain('<title>My API Docs</title>');
    expect(redoc).toContain('<title>My API Docs</title>');
  });

  it('returns the application instance for chaining', async () => {
    const { app, document } = await buildApp();
    const returned = app.mountOpenApi({ document, ui: 'all' });
    expect(returned).toBe(app);
  });
});
