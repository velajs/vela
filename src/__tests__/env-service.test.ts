import { describe, it, expect, beforeEach } from 'vitest';
import { Controller, Get, Inject, InjectionToken, MetadataRegistry, Module } from '@velajs/vela';
import { createCloudflareApp } from '../cloudflare-factory';
import { EnvModule } from '../modules/env.module';
import { EnvService } from '../services/env.service';

beforeEach(() => {
  MetadataRegistry.clear();
});

describe('EnvModule / EnvService', () => {
  it('injects EnvService and exposes the full env after the first request', async () => {
    @Controller('/env')
    class EnvController {
      constructor(@Inject(EnvService) private env: EnvService) {}

      @Get('/secret')
      secret() {
        return {
          secret: this.env.get<string>('AUTH_SECRET'),
          keys: Object.keys(this.env.env),
        };
      }
    }

    @Module({ imports: [EnvModule.forRoot()], controllers: [EnvController] })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/env/secret', undefined, {
      AUTH_SECRET: 's3cr3t',
      DB: { fake: true },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { secret: string; keys: string[] };
    expect(data.secret).toBe('s3cr3t');
    expect(data.keys).toContain('AUTH_SECRET');
    expect(data.keys).toContain('DB');
  });

  it('is global — a provider factory injects EnvService without importing EnvModule, read lazily', async () => {
    const SECRET_READER = new InjectionToken<{ read: () => string | undefined }>('SECRET_READER');

    @Controller('/feature')
    class FeatureController {
      constructor(@Inject(SECRET_READER) private reader: { read: () => string | undefined }) {}

      @Get('/secret')
      secret() {
        return { secret: this.reader.read() };
      }
    }

    // Deliberately does NOT import EnvModule — relies on it being global.
    @Module({
      providers: [
        {
          provide: SECRET_READER,
          inject: [EnvService],
          // Captures EnvService; reads lazily inside the closure (env is only
          // available per request, not at bootstrap when the factory runs).
          useFactory: (env: EnvService) => ({ read: () => env.get<string>('AUTH_SECRET') }),
        },
      ],
      controllers: [FeatureController],
    })
    class FeatureModule {}

    @Module({ imports: [EnvModule.forRoot(), FeatureModule] })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/feature/secret', undefined, { AUTH_SECRET: 'xyz' });
    expect(res.status).toBe(200);
    expect((await res.json()) as { secret: string }).toEqual({ secret: 'xyz' });
  });

  it('throws if env is read before the first request', async () => {
    @Module({ imports: [EnvModule.forRoot()] })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const env = app.get<EnvService>(EnvService);
    expect(() => env.env).toThrow(/not initialized/);
  });
});
