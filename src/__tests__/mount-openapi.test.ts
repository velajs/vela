import { describe, it, expect, beforeEach } from 'vitest';
import { Controller, Get, Module, MetadataRegistry } from '@velajs/vela';
import type { OpenApiDocument } from '@velajs/vela';
import { createCloudflareApp } from '../cloudflare-factory';

beforeEach(() => {
  MetadataRegistry.clear();
});

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
  it('serves the document JSON at /docs.json by default', async () => {
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
    const app = await createCloudflareApp(AppModule);
    app.mountOpenApi({ document, ui: 'scalar' });
    const hono = app.getHonoApp();

    const jsonRes = await hono.request('/docs.json', undefined, {});
    expect(jsonRes.status).toBe(200);
    expect(jsonRes.headers.get('content-type')).toMatch(/application\/json/);
    expect(await jsonRes.json()).toEqual(document);
  });

  it("serves the Scalar UI at /docs with a data-url pointing at /docs.json", async () => {
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
    const app = await createCloudflareApp(AppModule);
    app.mountOpenApi({ document, ui: 'scalar' });
    const hono = app.getHonoApp();

    const uiRes = await hono.request('/docs', undefined, {});
    expect(uiRes.status).toBe(200);
    expect(uiRes.headers.get('content-type')).toMatch(/text\/html/);

    const html = await uiRes.text();
    // Scalar UI HTML must reference our docs.json endpoint so the browser
    // can hydrate the API reference.
    expect(html).toContain('data-url="/docs.json"');
    expect(html).toContain('@scalar/api-reference');
  });

  it('returns the CloudflareApplication for chaining', async () => {
    @Module({})
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const result = app.mountOpenApi({ document: buildMinimalDoc(), ui: 'scalar' });
    expect(result).toBe(app);
  });

  it('honors custom path / uiPath options', async () => {
    @Module({})
    class AppModule {}

    const document = buildMinimalDoc();
    const app = await createCloudflareApp(AppModule);
    app.mountOpenApi({
      document,
      path: '/openapi.json',
      ui: 'scalar',
      uiPath: '/reference',
    });
    const hono = app.getHonoApp();

    const jsonRes = await hono.request('/openapi.json', undefined, {});
    expect(jsonRes.status).toBe(200);
    expect(await jsonRes.json()).toEqual(document);

    const uiRes = await hono.request('/reference', undefined, {});
    expect(uiRes.status).toBe(200);
    const html = await uiRes.text();
    expect(html).toContain('data-url="/openapi.json"');
  });
});
