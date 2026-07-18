import { beforeEach, describe, expect, it } from 'vitest';
import {
  Body,
  Controller,
  Injectable,
  MetadataRegistry,
  Module,
  Post,
  RawBody,
  SignedInvocation,
  Query,
  UseGuards,
  VelaFactory,
} from '../index.js';
import type { CanActivate, PipeTransform } from '../index.js';

beforeEach(() => MetadataRegistry.clear());

describe('HTTP security boundaries', () => {
  it('runs guards before malformed JSON parsing and pipes', async () => {
    let pipeCalls = 0;
    @Injectable()
    class DenyGuard implements CanActivate {
      canActivate(): boolean {
        return false;
      }
    }
    const trackingPipe: PipeTransform = {
      transform(value) {
        pipeCalls += 1;
        return value;
      },
    };

    @Controller('/guard-first')
    @UseGuards(DenyGuard)
    class GuardFirstController {
      @Post()
      handle(@Body(trackingPipe) _body: unknown) {
        return { leaked: true };
      }
    }

    @Module({ providers: [DenyGuard], controllers: [GuardFirstController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/guard-first', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    expect(res.status).toBe(403);
    expect(pipeCalls).toBe(0);
  });

  it('enforces the 1 MiB default before a raw-body handler runs', async () => {
    let hits = 0;

    @Controller('/body-limit')
    class BodyLimitController {
      @Post()
      handle(@RawBody() _body: Uint8Array) {
        hits++;
        return { ok: true };
      }
    }

    @Module({ controllers: [BodyLimitController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/body-limit', {
      method: 'POST',
      body: 'x'.repeat(1024 * 1024 + 1),
    });
    expect(res.status).toBe(413);
    expect(hits).toBe(0);
  });

  it('applies a configured limit before signed-invocation body capture', async () => {
    @Controller('/signed-limit')
    class SignedLimitController {
      @Post()
      @SignedInvocation()
      handle(@Body() _body: unknown) {
        return { ok: true };
      }
    }

    @Module({ controllers: [SignedLimitController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, { bodyLimit: 8 });
    const res = await app.getHonoApp().request('/signed-limit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tooLarge: true }),
    });
    expect(res.status).toBe(413);
  });

  it('rejects invalid body-limit configuration at bootstrap', async () => {
    @Module({})
    class AppModule {}
    await expect(VelaFactory.create(AppModule, { bodyLimit: 0 })).rejects.toThrow(/bodyLimit/);
  });

  it('supports a narrow streaming route override without weakening other routes', async () => {
    let streamHits = 0;
    let normalHits = 0;

    @Controller('/uploads')
    class UploadController {
      @Post('/stream')
      stream(@RawBody() body: Uint8Array) {
        streamHits++;
        return { size: body.byteLength };
      }

      @Post('/normal')
      normal(@RawBody() body: Uint8Array) {
        normalHits++;
        return { size: body.byteLength };
      }
    }

    @Module({ controllers: [UploadController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, {
      security: {
        body: {
          maxBytes: 8,
          streamingOverrides: [{ path: '/uploads/stream', methods: ['POST'], maxBytes: 64 }],
        },
      },
    });
    const hono = app.getHonoApp();

    const stream = await hono.request('/uploads/stream', { method: 'POST', body: 'x'.repeat(32) });
    const normal = await hono.request('/uploads/normal', { method: 'POST', body: 'x'.repeat(32) });
    expect(stream.status).toBe(200);
    expect(await stream.json()).toEqual({ size: 32 });
    expect(normal.status).toBe(413);
    expect(streamHits).toBe(1);
    expect(normalHits).toBe(0);
  });

  it('bounds query parameter count and nesting depth before handlers run', async () => {
    let hits = 0;

    @Controller('/query-limit')
    class QueryController {
      @Post()
      handle(@Query() query: Record<string, string>) {
        hits++;
        return query;
      }
    }

    @Module({ controllers: [QueryController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, {
      security: { query: { maxParameters: 2, maxDepth: 1, maxBytes: 128 } },
    });
    const hono = app.getHonoApp();

    expect((await hono.request('/query-limit?a=1&b=2&c=3', { method: 'POST' })).status).toBe(400);
    expect((await hono.request('/query-limit?a%5Bb%5D%5Bc%5D=1', { method: 'POST' })).status).toBe(
      400,
    );
    expect(
      (await hono.request(`/query-limit?a=?${'x'.repeat(129)}`, { method: 'POST' })).status,
    ).toBe(400);
    expect((await hono.request('/query-limit?a=1&b=2', { method: 'POST' })).status).toBe(200);
    expect(hits).toBe(1);
  });

  it('rejects ambiguous legacy and unified body-limit configuration', async () => {
    @Module({})
    class AppModule {}

    await expect(
      VelaFactory.create(AppModule, {
        bodyLimit: 8,
        security: { body: { maxBytes: 16 } },
      }),
    ).rejects.toThrow(/either bodyLimit or security\.body\.maxBytes/);
  });
});
