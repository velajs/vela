import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  Controller,
  Get,
  Module,
  Injectable,
  MetadataRegistry,
} from '@velajs/vela';
import { CloudflareFactory } from '../cloudflare-factory';
import { DurableObjectModule } from '../modules/durable-object.module';
import { DurableObjectService } from '../services/durable-object.service';
import { clearBindingsRegistry } from '../tokens';

beforeEach(() => {
  MetadataRegistry.clear();
  clearBindingsRegistry();
});

function createMockDO() {
  const stubs = new Map<string, { fetch: Function }>();
  return {
    newUniqueId: (options?: Record<string, unknown>) => ({
      toString: () => 'unique-id-abc123',
      ...options,
    }),
    idFromName: (name: string) => ({
      toString: () => `name-id-${name}`,
    }),
    idFromString: (hexStr: string) => ({
      toString: () => hexStr,
    }),
    get: (id: { toString: () => string }) => {
      const key = id.toString();
      if (!stubs.has(key)) {
        stubs.set(key, {
          fetch: async (input: string) => new Response(JSON.stringify({ url: input, stub: key })),
        });
      }
      return stubs.get(key);
    },
    jurisdiction: (name: string) => ({
      name,
      get: (id: unknown) => ({ fetch: async () => new Response('jurisdiction') }),
    }),
  };
}

describe('DurableObjectModule', () => {
  it('should inject DurableObjectService with idFromName and get', async () => {
    const mockDO = createMockDO();

    @Controller('/do')
    class DOController {
      constructor(private doNs: DurableObjectService) {}

      @Get('/call')
      async call() {
        const id = this.doNs.idFromName('counter');
        const stub = this.doNs.get(id) as { fetch: Function };
        const res = await stub.fetch('/increment');
        return res.json();
      }
    }

    @Module({
      imports: [DurableObjectModule.forRoot({ binding: 'COUNTER' })],
      controllers: [DOController],
    })
    class AppModule {}

    const app = await CloudflareFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/do/call', undefined, { COUNTER: mockDO });
    expect(res.status).toBe(200);
    const data = await res.json() as { url: string; stub: string };
    expect(data.url).toBe('/increment');
    expect(data.stub).toBe('name-id-counter');
  });

  it('should support newUniqueId', async () => {
    const mockDO = createMockDO();

    @Controller('/do')
    class DOController {
      constructor(private doNs: DurableObjectService) {}

      @Get('/unique')
      async unique() {
        const id = this.doNs.newUniqueId() as { toString: () => string };
        return { id: id.toString() };
      }
    }

    @Module({
      imports: [DurableObjectModule.forRoot({ binding: 'MY_DO' })],
      controllers: [DOController],
    })
    class AppModule {}

    const app = await CloudflareFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/do/unique', undefined, { MY_DO: mockDO });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'unique-id-abc123' });
  });

  it('should expose raw namespace via .namespace getter', async () => {
    const mockDO = createMockDO();

    @Controller('/raw')
    class RawController {
      constructor(private doNs: DurableObjectService) {}

      @Get()
      async test() {
        const ns = this.doNs.namespace;
        const id = ns.idFromString('abc123');
        return { id: id.toString() };
      }
    }

    @Module({
      imports: [DurableObjectModule.forRoot({ binding: 'RAW_DO' })],
      controllers: [RawController],
    })
    class AppModule {}

    const app = await CloudflareFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/raw', undefined, { RAW_DO: mockDO });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'abc123' });
  });

  it('should allow DurableObjectService in nested providers', async () => {
    const mockDO = createMockDO();

    @Injectable()
    class CounterClient {
      constructor(private doNs: DurableObjectService) {}
      async callCounter(name: string) {
        const id = this.doNs.idFromName(name);
        const stub = this.doNs.get(id) as { fetch: Function };
        const res = await stub.fetch('/value');
        return res.json();
      }
    }

    @Controller('/counters')
    class CounterController {
      constructor(private client: CounterClient) {}

      @Get('/test')
      async test() {
        return this.client.callCounter('test');
      }
    }

    @Module({
      imports: [DurableObjectModule.forRoot({ binding: 'COUNTERS' })],
      providers: [CounterClient],
      controllers: [CounterController],
    })
    class AppModule {}

    const app = await CloudflareFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/counters/test', undefined, { COUNTERS: mockDO });
    expect(res.status).toBe(200);
    const data = await res.json() as { url: string };
    expect(data.url).toBe('/value');
  });
});
