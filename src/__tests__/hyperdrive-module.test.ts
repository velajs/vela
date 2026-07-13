import { describe, it, expect, beforeEach } from 'vitest';
import { Controller, Get, Module, Injectable, MetadataRegistry } from '@velajs/vela';
import { createCloudflareApp } from '../cloudflare-factory';
import { HyperdriveModule } from '../modules/hyperdrive.module';
import { HyperdriveService } from '../services/hyperdrive.service';
beforeEach(() => {
  MetadataRegistry.clear();
});

function createMockHyperdrive() {
  return {
    connectionString: 'postgresql://user:pass@hyperdrive.local:5432/mydb',
    host: 'hyperdrive.local',
    port: 5432,
    user: 'user',
    password: 'pass',
    database: 'mydb',
  };
}

describe('HyperdriveModule', () => {
  it('should inject HyperdriveService with connection properties', async () => {
    const mockHD = createMockHyperdrive();

    @Controller('/db')
    class DbController {
      constructor(private hd: HyperdriveService) {}

      @Get('/info')
      async info() {
        return {
          connectionString: this.hd.connectionString,
          host: this.hd.host,
          port: this.hd.port,
          user: this.hd.user,
          database: this.hd.database,
        };
      }
    }

    @Module({
      imports: [HyperdriveModule.forRoot({ binding: 'POSTGRES' })],
      controllers: [DbController],
    })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/db/info', undefined, { POSTGRES: mockHD });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.connectionString).toBe('postgresql://user:pass@hyperdrive.local:5432/mydb');
    expect(data.host).toBe('hyperdrive.local');
    expect(data.port).toBe(5432);
    expect(data.user).toBe('user');
    expect(data.database).toBe('mydb');
  });

  it('should expose password property', async () => {
    const mockHD = createMockHyperdrive();

    @Controller('/db')
    class DbController {
      constructor(private hd: HyperdriveService) {}

      @Get('/pass')
      async pass() {
        return { hasPassword: this.hd.password.length > 0 };
      }
    }

    @Module({
      imports: [HyperdriveModule.forRoot({ binding: 'PG' })],
      controllers: [DbController],
    })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/db/pass', undefined, { PG: mockHD });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasPassword: true });
  });

  it('should expose raw binding via .binding getter', async () => {
    const mockHD = createMockHyperdrive();

    @Controller('/raw')
    class RawController {
      constructor(private hd: HyperdriveService) {}

      @Get()
      async test() {
        const binding = this.hd.binding;
        return { host: binding.host, port: binding.port };
      }
    }

    @Module({
      imports: [HyperdriveModule.forRoot({ binding: 'RAW_HD' })],
      controllers: [RawController],
    })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/raw', undefined, { RAW_HD: mockHD });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ host: 'hyperdrive.local', port: 5432 });
  });

  it('should allow HyperdriveService in nested providers', async () => {
    const mockHD = createMockHyperdrive();

    @Injectable()
    class DatabaseClient {
      constructor(private hd: HyperdriveService) {}
      getConfig() {
        return {
          host: this.hd.host,
          port: this.hd.port,
          user: this.hd.user,
          password: this.hd.password,
          database: this.hd.database,
        };
      }
    }

    @Controller('/client')
    class ClientController {
      constructor(private db: DatabaseClient) {}

      @Get('/config')
      async config() {
        return this.db.getConfig();
      }
    }

    @Module({
      imports: [HyperdriveModule.forRoot({ binding: 'DB' })],
      providers: [DatabaseClient],
      controllers: [ClientController],
    })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/client/config', undefined, { DB: mockHD });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.host).toBe('hyperdrive.local');
    expect(data.database).toBe('mydb');
  });
});
