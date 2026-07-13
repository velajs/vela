import { describe, it, expect, beforeEach } from 'vitest';
import {
  VelaFactory,
  Controller,
  Get,
  Module,
  Injectable,
  Inject,
  MetadataRegistry,
  ConfigModule,
  ConfigService,
  CONFIG_OPTIONS,
} from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

describe('ConfigModule', () => {
  describe('ConfigService basic operations', () => {
    it('should resolve ConfigService after ConfigModule.forRoot()', async () => {
      @Module({
        imports: [
          ConfigModule.forRoot({
            config: { port: 3000, host: 'localhost' },
          }),
        ],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const configService = app.get(ConfigService);

      expect(configService).toBeInstanceOf(ConfigService);
    });

    it('should get values by key', async () => {
      @Module({
        imports: [
          ConfigModule.forRoot({
            config: { port: 3000, host: 'localhost', debug: true },
          }),
        ],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const configService = app.get(ConfigService);

      expect(configService.get('port')).toBe(3000);
      expect(configService.get('host')).toBe('localhost');
      expect(configService.get('debug')).toBe(true);
    });

    it('should return undefined for missing keys', async () => {
      @Module({
        imports: [ConfigModule.forRoot({ config: { a: 1 } })],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const configService = app.get(ConfigService);

      expect(configService.get('missing')).toBeUndefined();
    });

    it('should return default value for missing keys', async () => {
      @Module({
        imports: [ConfigModule.forRoot({ config: { a: 1 } })],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const configService = app.get(ConfigService);

      expect(configService.get('missing', 'fallback')).toBe('fallback');
      expect(configService.get('missing', 42)).toBe(42);
    });
  });

  describe('dot-notation access', () => {
    it('should traverse nested objects', async () => {
      @Module({
        imports: [
          ConfigModule.forRoot({
            config: {
              db: { host: 'pg.local', port: 5432, credentials: { user: 'admin', pass: 'secret' } },
              cache: { ttl: 60 },
            },
          }),
        ],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const configService = app.get(ConfigService);

      expect(configService.get('db.host')).toBe('pg.local');
      expect(configService.get('db.port')).toBe(5432);
      expect(configService.get('db.credentials.user')).toBe('admin');
      expect(configService.get('cache.ttl')).toBe(60);
    });

    it('should return default for non-existent nested path', async () => {
      @Module({
        imports: [ConfigModule.forRoot({ config: { db: { host: 'local' } } })],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const configService = app.get(ConfigService);

      expect(configService.get('db.port', 3306)).toBe(3306);
      expect(configService.get('nonexistent.deep.path')).toBeUndefined();
    });
  });

  describe('getAll', () => {
    it('should return the full config object', async () => {
      const config = { x: 1, y: 'two', z: true };

      @Module({
        imports: [ConfigModule.forRoot({ config })],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const configService = app.get(ConfigService);

      expect(configService.getAll()).toEqual(config);
    });
  });

  describe('validation', () => {
    it('should run validate function on config', async () => {
      const validated = { port: 3000, validated: true };

      @Module({
        imports: [
          ConfigModule.forRoot({
            config: { port: 3000 },
            validate: (cfg) => ({ ...cfg, validated: true }),
          }),
        ],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const configService = app.get(ConfigService);

      expect(configService.get('validated')).toBe(true);
      expect(configService.get('port')).toBe(3000);
    });

    it('should throw when validation fails', () => {
      expect(() =>
        ConfigModule.forRoot({
          config: { port: -1 },
          validate: (cfg) => {
            if ((cfg as any).port < 0) throw new Error('Invalid port');
            return cfg;
          },
        }),
      ).toThrow('Invalid port');
    });
  });

  describe('integration with controllers', () => {
    it('should inject ConfigService into controllers', async () => {
      @Controller('/app')
      class AppController {
        constructor(private config: ConfigService) {}

        @Get('/info')
        getInfo() {
          return {
            name: this.config.get('name'),
            version: this.config.get('version'),
          };
        }
      }

      @Module({
        imports: [
          ConfigModule.forRoot({
            config: { name: 'MyApp', version: '1.0.0' },
          }),
        ],
        controllers: [AppController],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const res = await app.getHonoApp().request('/app/info');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ name: 'MyApp', version: '1.0.0' });
    });
  });

  describe('forRootAsync()', () => {
    it('should resolve config from an injected factory dependency', async () => {
      @Injectable()
      class EnvProvider {
        get(key: string) {
          return key === 'APP_NAME' ? 'async-app' : undefined;
        }
      }

      @Controller('/async-cfg')
      class AsyncCfgController {
        constructor(private config: ConfigService) {}
        @Get()
        handle() {
          return { name: this.config.get('APP_NAME') };
        }
      }

      @Module({
        imports: [
          ConfigModule.forRootAsync({
            useFactory: (env: EnvProvider) => ({
              config: { APP_NAME: env.get('APP_NAME') },
            }),
            inject: [EnvProvider],
          }),
        ],
        providers: [EnvProvider],
        controllers: [AsyncCfgController],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const res = await app.getHonoApp().request('/async-cfg');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ name: 'async-app' });
    });
  });
});
