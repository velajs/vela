const env = {};
import { describe, it, expect } from 'vitest';
import { Controller, Get, Module } from '@velajs/vela';
import type { OpenApiDocument } from '@velajs/vela';
import { createCloudflareApp } from '../cloudflare-factory';

function buildMinimalDoc(): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: { title: 'Test API', version: '1.0.0' },
    paths: {
      '/health': {
        get: {
          summary: 'Health check',
          responses: {
            '200': { description: 'OK' },
          },
        },
      },
    },
  };
}

describe('CloudflareApplication.mountOpenApi', () => {
  it('serves the document JSON at /openapi.json by default', async () => {
    @Controller('/health')
    class HealthController {
      @Get()
      check() {
        return { status: 'ok' };
      }
    }

    @Module({ controllers: [HealthController] })
    class AppModule {}

    const document = buildMinimalDoc();
    const app = await createCloudflareApp(AppModule, { env });
    app.mountOpenApi({ document, ui: 'scalar' });
    const hono = app.getHonoApp();

    const jsonRes = await hono.request('/openapi.json', undefined, env);
    expect(jsonRes.status).toBe(200);
    expect(jsonRes.headers.get('content-type')).toMatch(/application\/json/);
    expect(await jsonRes.json()).toEqual(document);
  });

  it('serves the Scalar UI at /scalar with a data-url pointing at /openapi.json', async () => {
    @Controller('/ping')
    class PingController {
      @Get()
      ping() {
        return { pong: true };
      }
    }

    @Module({ controllers: [PingController] })
    class AppModule {}

    const document = buildMinimalDoc();
    const app = await createCloudflareApp(AppModule, { env });
    app.mountOpenApi({ document, ui: 'scalar' });
    const hono = app.getHonoApp();

    const uiRes = await hono.request('/scalar', undefined, env);
    expect(uiRes.status).toBe(200);
    expect(uiRes.headers.get('content-type')).toMatch(/text\/html/);

    const html = await uiRes.text();
    // Scalar UI HTML must reference the spec endpoint so the browser can
    // hydrate the API reference. vela 1.8.x defaults the spec to /openapi.json
    // and the Scalar UI to /scalar (overridable via specPath / scalarPath).
    expect(html).toContain('data-url="/openapi.json"');
    expect(html).toContain('@scalar/api-reference');
  });

  it('returns the CloudflareApplication for chaining', async () => {
    @Module({})
    class AppModule {}

    const app = await createCloudflareApp(AppModule, { env });
    const result = app.mountOpenApi({ document: buildMinimalDoc(), ui: 'scalar' });
    expect(result).toBe(app);
  });

  it('honors custom path / uiPath options', async () => {
    @Module({})
    class AppModule {}

    const document = buildMinimalDoc();
    const app = await createCloudflareApp(AppModule, { env });
    app.mountOpenApi({
      document,
      path: '/openapi.json',
      ui: 'scalar',
      uiPath: '/reference',
    });
    const hono = app.getHonoApp();

    const jsonRes = await hono.request('/openapi.json', undefined, env);
    expect(jsonRes.status).toBe(200);
    expect(await jsonRes.json()).toEqual(document);

    const uiRes = await hono.request('/reference', undefined, env);
    expect(uiRes.status).toBe(200);
    const html = await uiRes.text();
    expect(html).toContain('data-url="/openapi.json"');
  });
});
