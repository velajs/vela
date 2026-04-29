import { describe, it, expect, beforeEach } from 'vitest';
import {
  Controller,
  Get,
  Module,
  Injectable,
  MetadataRegistry,
} from '@velajs/vela';
import { createCloudflareApp } from '../cloudflare-factory';
import { KVModule } from '../modules/kv.module';
import { D1Module } from '../modules/d1.module';
import { R2Module } from '../modules/r2.module';
import { KVService } from '../services/kv.service';
import { D1Service } from '../services/d1.service';
import { R2Service } from '../services/r2.service';
import { Env } from '../decorators/env';
import { Scheduled } from '../decorators/scheduled';
import { QueueConsumer } from '../decorators/queue-consumer';
import { clearBindingsRegistry } from '../tokens';

beforeEach(() => {
  MetadataRegistry.clear();
  clearBindingsRegistry();
});

function createMockKV() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    getWithMetadata: async (key: string) => ({ value: store.get(key) ?? null, metadata: null }),
    put: async (key: string, value: string) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
    list: async () => ({ keys: [...store.keys()].map((name) => ({ name })), list_complete: true }),
    _store: store,
  };
}

function createMockD1() {
  const rows = [{ id: '1', name: 'Alice' }, { id: '2', name: 'Bob' }];
  return {
    prepare: (query: string) => ({
      bind: (...values: unknown[]) => ({
        first: async () => rows.find((r) => r.id === values[0]) ?? null,
        all: async () => ({ results: rows }),
        run: async () => ({ success: true }),
      }),
      first: async () => rows[0],
      all: async () => ({ results: rows }),
      run: async () => ({ success: true }),
    }),
    batch: async (stmts: unknown[]) => stmts.map(() => ({ results: [] })),
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  };
}

function createMockR2() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => {
      const val = store.get(key);
      if (!val) return null;
      return { key, body: val, text: async () => val };
    },
    head: async (key: string) => store.has(key) ? { key, size: (store.get(key) ?? '').length } : null,
    put: async (key: string, value: string) => { store.set(key, String(value)); return { key }; },
    delete: async (keys: string | string[]) => {
      for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k);
    },
    list: async () => ({ objects: [...store.entries()].map(([key]) => ({ key })), truncated: false }),
  };
}

describe('Integration: multiple modules in one app', () => {
  it('should use KV + D1 + R2 together', async () => {
    const mockKV = createMockKV();
    const mockD1 = createMockD1();
    const mockR2 = createMockR2();

    @Injectable()
    class UserService {
      constructor(
        private kv: KVService,
        private d1: D1Service,
      ) {}

      async getUser(id: string) {
        // Check cache first
        const cached = await this.kv.get(`user:${id}`);
        if (cached) return JSON.parse(cached as string);
        // Fallback to D1
        const user = await this.d1.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
        if (user) await this.kv.put(`user:${id}`, JSON.stringify(user));
        return user;
      }
    }

    @Controller('/users')
    class UserController {
      constructor(private userService: UserService) {}

      @Get('/1')
      async getUser() {
        const user = await this.userService.getUser('1');
        return { user };
      }
    }

    @Controller('/files')
    class FileController {
      constructor(private r2: R2Service) {}

      @Get('/upload')
      async upload() {
        await this.r2.put('avatar.png', 'binary-data');
        return { uploaded: true };
      }

      @Get('/download')
      async download() {
        const obj = (await this.r2.get('avatar.png')) as { text: () => Promise<string> } | null;
        return { content: obj ? await obj.text() : null };
      }
    }

    @Module({
      imports: [
        KVModule.forRoot({ binding: 'CACHE' }),
        D1Module.forRoot({ binding: 'DB' }),
        R2Module.forRoot({ binding: 'ASSETS' }),
      ],
      providers: [UserService],
      controllers: [UserController, FileController],
    })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();
    const env = { CACHE: mockKV, DB: mockD1, ASSETS: mockR2 };

    // Get user — falls back to D1, then caches in KV
    const userRes = await hono.request('/users/1', undefined, env);
    expect(userRes.status).toBe(200);
    const userData = (await userRes.json()) as { user: { id: string; name: string } };
    expect(userData.user).toEqual({ id: '1', name: 'Alice' });

    // KV should now have the cached user
    expect(mockKV._store.has('user:1')).toBe(true);

    // Second request uses cache
    const userRes2 = await hono.request('/users/1', undefined, env);
    expect(userRes2.status).toBe(200);
    expect(await userRes2.json()).toEqual({ user: { id: '1', name: 'Alice' } });

    // Upload file to R2
    const uploadRes = await hono.request('/files/upload', undefined, env);
    expect(uploadRes.status).toBe(200);

    // Download file from R2
    const downloadRes = await hono.request('/files/download', undefined, env);
    expect(downloadRes.status).toBe(200);
    expect(await downloadRes.json()).toEqual({ content: 'binary-data' });
  });

  it('should combine @Env() with module-injected services', async () => {
    const mockKV = createMockKV();

    @Controller('/hybrid')
    class HybridController {
      constructor(private kv: KVService) {}

      @Get('/via-service')
      async viaService() {
        await this.kv.put('source', 'service');
        return { source: 'service' };
      }

      @Get('/via-env')
      async viaEnv(@Env('CACHE') rawKV: unknown) {
        const kv = rawKV as { get: (k: string) => Promise<string | null> };
        const val = await kv.get('source');
        return { value: val };
      }
    }

    @Module({
      imports: [KVModule.forRoot({ binding: 'CACHE' })],
      controllers: [HybridController],
    })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();
    const env = { CACHE: mockKV };

    // Write via service
    const writeRes = await hono.request('/hybrid/via-service', undefined, env);
    expect(writeRes.status).toBe(200);

    // Read via raw @Env() binding — same underlying KV
    const readRes = await hono.request('/hybrid/via-env', undefined, env);
    expect(readRes.status).toBe(200);
    expect(await readRes.json()).toEqual({ value: 'service' });
  });

  it('should support scheduled + queue in the same app with HTTP routes', async () => {
    const mockKV = createMockKV();
    const cronCalls: string[] = [];
    const queueMessages: unknown[] = [];

    @Injectable()
    class WorkerService {
      constructor(private kv: KVService) {}

      @Scheduled('0 * * * *')
      async hourlyCleanup() {
        cronCalls.push('cleanup');
      }

      @QueueConsumer('notifications')
      async processNotifications(batch: { messages: { body: unknown }[] }) {
        for (const msg of batch.messages) {
          queueMessages.push(msg.body);
        }
      }
    }

    @Controller('/health')
    class HealthController {
      @Get()
      check() {
        return { status: 'ok' };
      }
    }

    @Module({
      imports: [KVModule.forRoot({ binding: 'KV' })],
      providers: [WorkerService],
      controllers: [HealthController],
    })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();
    const ctx = { waitUntil: () => {} };

    // HTTP route works
    const healthRes = await hono.request('/health', undefined, { KV: mockKV });
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual({ status: 'ok' });

    // Scheduled handler works
    await app.scheduled({ cron: '0 * * * *' }, {}, ctx);
    expect(cronCalls).toEqual(['cleanup']);

    // Queue consumer works
    await app.queue(
      { queue: 'notifications', messages: [{ body: { text: 'hello' } }] },
      {},
      ctx,
    );
    expect(queueMessages).toEqual([{ text: 'hello' }]);
  });
});
