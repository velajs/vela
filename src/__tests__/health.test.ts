import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  VelaFactory,
  Controller,
  Get,
  Module,
  MetadataRegistry,
} from '../index.js';
import {
  HealthModule,
  HealthCheckService,
  HealthIndicatorService,
  HttpHealthIndicator,
} from '../health/index.js';
import { ServiceUnavailableException } from '../errors/http-exception.js';

beforeEach(() => {
  MetadataRegistry.clear();
  // Re-register HealthModule metadata after clear — the @Module() decorator
  // runs once at import time, but MetadataRegistry.clear() wipes it.
  MetadataRegistry.setModuleOptions(HealthModule, {
    providers: [HealthCheckService, HealthIndicatorService, HttpHealthIndicator],
    exports: [HealthCheckService, HealthIndicatorService, HttpHealthIndicator],
  });
});

describe('HealthIndicatorService', () => {
  it('should produce up result with correct shape', () => {
    const indicator = new HealthIndicatorService();
    const result = indicator.check('db').up({ responseTime: 10 });
    expect(result).toEqual({
      db: { status: 'up', responseTime: 10 },
    });
  });

  it('should produce down result with correct shape', () => {
    const indicator = new HealthIndicatorService();
    const result = indicator.check('db').down({ message: 'Connection refused' });
    expect(result).toEqual({
      db: { status: 'down', message: 'Connection refused' },
    });
  });

  it('should produce up result without extra data', () => {
    const indicator = new HealthIndicatorService();
    const result = indicator.check('redis').up();
    expect(result).toEqual({
      redis: { status: 'up' },
    });
  });

  it('should produce down result without extra data', () => {
    const indicator = new HealthIndicatorService();
    const result = indicator.check('redis').down();
    expect(result).toEqual({
      redis: { status: 'down' },
    });
  });
});

describe('HttpHealthIndicator', () => {
  const indicator = new HealthIndicatorService();

  it('should return up for 2xx response', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('OK', { status: 200, statusText: 'OK' }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const http = new HttpHealthIndicator(indicator);
    const result = await http.pingCheck('api', 'https://example.com/health');

    expect(result).toEqual({
      api: { status: 'up', statusCode: 200 },
    });
    expect(mockFetch).toHaveBeenCalledWith('https://example.com/health', {
      method: 'GET',
      headers: undefined,
      signal: expect.any(AbortSignal),
    });

    vi.unstubAllGlobals();
  });

  it('should return down for non-2xx response', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('Not Found', { status: 404, statusText: 'Not Found' }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const http = new HttpHealthIndicator(indicator);
    const result = await http.pingCheck('api', 'https://example.com/missing');

    expect(result).toEqual({
      api: { status: 'down', statusCode: 404, message: 'Not Found' },
    });

    vi.unstubAllGlobals();
  });

  it('should return down on network error', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('fetch failed'));
    vi.stubGlobal('fetch', mockFetch);

    const http = new HttpHealthIndicator(indicator);
    const result = await http.pingCheck('api', 'https://unreachable.local');

    expect(result).toEqual({
      api: { status: 'down', message: 'fetch failed' },
    });

    vi.unstubAllGlobals();
  });

  it('should respect expectedStatus option', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('', { status: 301, statusText: 'Moved Permanently' }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const http = new HttpHealthIndicator(indicator);
    const result = await http.pingCheck('redirect', 'https://example.com/old', {
      expectedStatus: 301,
    });

    expect(result).toEqual({
      redirect: { status: 'up', statusCode: 301 },
    });

    vi.unstubAllGlobals();
  });
});

describe('HttpHealthIndicator.responseCheck', () => {
  const indicator = new HealthIndicatorService();

  it('should return up when callback returns true', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('{"healthy":true}', { status: 200 }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const http = new HttpHealthIndicator(indicator);
    const result = await http.responseCheck(
      'api',
      'https://example.com/health',
      (res) => res.status === 200,
    );

    expect(result).toEqual({
      api: { status: 'up', statusCode: 200 },
    });

    vi.unstubAllGlobals();
  });

  it('should return down when callback returns false', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('{"healthy":false}', { status: 200 }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const http = new HttpHealthIndicator(indicator);
    const result = await http.responseCheck(
      'api',
      'https://example.com/health',
      async (res) => {
        const body = await res.json();
        return body.healthy === true;
      },
    );

    expect(result).toEqual({
      api: { status: 'down', statusCode: 200 },
    });

    vi.unstubAllGlobals();
  });

  it('should return down on network error', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('fetch failed'));
    vi.stubGlobal('fetch', mockFetch);

    const http = new HttpHealthIndicator(indicator);
    const result = await http.responseCheck(
      'api',
      'https://unreachable.local',
      () => true,
    );

    expect(result).toEqual({
      api: { status: 'down', message: 'fetch failed' },
    });

    vi.unstubAllGlobals();
  });

  it('should pass the Response object to the callback', async () => {
    const mockResponse = new Response('test-body', {
      status: 200,
      headers: { 'x-custom': 'value' },
    });
    const mockFetch = vi.fn().mockResolvedValue(mockResponse);
    vi.stubGlobal('fetch', mockFetch);

    const callback = vi.fn().mockReturnValue(true);
    const http = new HttpHealthIndicator(indicator);
    await http.responseCheck('api', 'https://example.com', callback);

    expect(callback).toHaveBeenCalledTimes(1);
    const receivedResponse = callback.mock.calls[0][0];
    expect(receivedResponse).toBeInstanceOf(Response);
    expect(receivedResponse.status).toBe(200);
    expect(receivedResponse.headers.get('x-custom')).toBe('value');

    vi.unstubAllGlobals();
  });
});

describe('HealthCheckService', () => {
  it('should return ok when all indicators are healthy', async () => {
    const service = new HealthCheckService();
    const result = await service.check([
      async () => ({ db: { status: 'up', responseTime: 5 } }),
      async () => ({ redis: { status: 'up' } }),
    ]);

    expect(result).toEqual({
      status: 'ok',
      info: {
        db: { status: 'up', responseTime: 5 },
        redis: { status: 'up' },
      },
      error: {},
      details: {
        db: { status: 'up', responseTime: 5 },
        redis: { status: 'up' },
      },
    });
  });

  it('should throw ServiceUnavailableException when any indicator is down', async () => {
    const service = new HealthCheckService();

    try {
      await service.check([
        async () => ({ db: { status: 'up' } }),
        async () => ({ redis: { status: 'down', message: 'Connection refused' } }),
      ]);
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      const exc = error as ServiceUnavailableException;
      expect(exc.getStatus()).toBe(503);
      const response = exc.getResponse() as Record<string, unknown>;
      expect(response.status).toBe('error');
      expect(response.info).toEqual({ db: { status: 'up' } });
      expect(response.error).toEqual({ redis: { status: 'down', message: 'Connection refused' } });
      expect(response.details).toEqual({
        db: { status: 'up' },
        redis: { status: 'down', message: 'Connection refused' },
      });
    }
  });

  it('should catch throwing indicators and record as down', async () => {
    const service = new HealthCheckService();

    try {
      await service.check([
        async () => ({ db: { status: 'up' } }),
        async () => {
          throw new Error('Redis exploded');
        },
      ]);
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      const response = (error as ServiceUnavailableException).getResponse() as Record<string, unknown>;
      expect(response.status).toBe('error');
      expect(response.info).toEqual({ db: { status: 'up' } });
      expect(response.error).toEqual({ unknown: { status: 'down', message: 'Redis exploded' } });
    }
  });

  it('should run all checks concurrently (all appear in details even if one fails)', async () => {
    const service = new HealthCheckService();
    const order: string[] = [];

    try {
      await service.check([
        async () => {
          order.push('db');
          return { db: { status: 'up' } };
        },
        async () => {
          order.push('redis');
          return { redis: { status: 'down', message: 'timeout' } };
        },
        async () => {
          order.push('api');
          return { api: { status: 'up' } };
        },
      ]);
    } catch (error) {
      const response = (error as ServiceUnavailableException).getResponse() as Record<string, unknown>;
      const details = response.details as Record<string, unknown>;
      expect(details).toHaveProperty('db');
      expect(details).toHaveProperty('redis');
      expect(details).toHaveProperty('api');
      expect(order).toHaveLength(3);
    }
  });
});

describe('HealthCheckService shutting_down', () => {
  it('should return shutting_down status after beforeApplicationShutdown is called', async () => {
    const service = new HealthCheckService();
    service.beforeApplicationShutdown();

    try {
      await service.check([
        async () => ({ db: { status: 'up' } }),
      ]);
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      const exc = error as ServiceUnavailableException;
      expect(exc.getStatus()).toBe(503);
      const response = exc.getResponse() as Record<string, unknown>;
      expect(response.status).toBe('shutting_down');
      expect(response.info).toEqual({});
      expect(response.error).toEqual({});
      expect(response.details).toEqual({});
    }
  });

  it('should return shutting_down via app.close() integration', async () => {
    @Controller('/health')
    class HealthController {
      constructor(
        private health: HealthCheckService,
        private indicator: HealthIndicatorService,
      ) {}

      @Get()
      async check() {
        return this.health.check([
          async () => this.indicator.check('app').up(),
        ]);
      }
    }

    @Module({
      imports: [HealthModule],
      controllers: [HealthController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    // Health check works before shutdown
    const resBefore = await hono.request('/health');
    expect(resBefore.status).toBe(200);

    // Trigger shutdown lifecycle
    await app.close();

    // Health check returns 503 with shutting_down after shutdown
    const resAfter = await hono.request('/health');
    expect(resAfter.status).toBe(503);
    expect(await resAfter.json()).toEqual({
      status: 'shutting_down',
      info: {},
      error: {},
      details: {},
    });
  });
});

describe('HealthModule integration', () => {
  it('should wire up health check endpoint end-to-end', async () => {
    @Controller('/health')
    class HealthController {
      constructor(
        private health: HealthCheckService,
        private indicator: HealthIndicatorService,
      ) {}

      @Get()
      async check() {
        return this.health.check([
          async () => this.indicator.check('app').up({ version: '1.0.0' }),
        ]);
      }
    }

    @Module({
      imports: [HealthModule],
      controllers: [HealthController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ok',
      info: { app: { status: 'up', version: '1.0.0' } },
      error: {},
      details: { app: { status: 'up', version: '1.0.0' } },
    });
  });

  it('should return 503 when a health check fails', async () => {
    @Controller('/health')
    class HealthController {
      constructor(
        private health: HealthCheckService,
        private indicator: HealthIndicatorService,
      ) {}

      @Get()
      async check() {
        return this.health.check([
          async () => this.indicator.check('app').up(),
          async () => this.indicator.check('db').down({ message: 'No connection' }),
        ]);
      }
    }

    @Module({
      imports: [HealthModule],
      controllers: [HealthController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/health');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: 'error',
      info: { app: { status: 'up' } },
      error: { db: { status: 'down', message: 'No connection' } },
      details: {
        app: { status: 'up' },
        db: { status: 'down', message: 'No connection' },
      },
    });
  });
});
