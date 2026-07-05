import { describe, it, expect, beforeEach } from 'vitest';
import {
  VelaFactory,
  Module,
  Global,
  Injectable,
  Inject,
  Container,
  MetadataRegistry,
  ConfigModule,
  ConfigService,
  ConfigStore,
  CONFIG_ENV,
  CONFIG_OPTIONS,
  registerAs,
  type ConfigType,
  type InferConfigType,
} from '../index.js';

interface TestEnv {
  DATABASE_URL?: string;
  MAIL_FROM?: string;
}

// Namespaces are declared once at module scope — `Symbol.for` keeps their KEY
// identity stable across re-evaluation, exactly the property registerAs relies on.
const dbConfig = registerAs('database', (env: TestEnv) => ({
  url: env.DATABASE_URL ?? 'sqlite::memory:',
  pool: 10,
}));

const mailConfig = registerAs('mail', (env: TestEnv) => ({
  from: env.MAIL_FROM ?? 'noreply@example.com',
}));

/** A @Global module that seeds CONFIG_ENV — how a platform adapter provides env. */
function seedEnv(env: Record<string, unknown>) {
  @Global()
  @Module({
    providers: [{ provide: CONFIG_ENV, useValue: env }],
    exports: [CONFIG_ENV],
  })
  class EnvModule {}
  return EnvModule;
}

beforeEach(() => {
  MetadataRegistry.clear();
});

describe('registerAs config namespaces', () => {
  describe('registerAs()', () => {
    it('mints a stable Symbol.for KEY and captures namespace + factory', () => {
      expect(dbConfig.KEY as unknown as symbol).toBe(Symbol.for('vela:config:database'));
      expect(dbConfig.namespace).toBe('database');
      expect(dbConfig.factory({ DATABASE_URL: 'x' })).toEqual({ url: 'x', pool: 10 });
    });

    it('asProvider() yields a factory provider injecting CONFIG_ENV', () => {
      const provider = dbConfig.asProvider();
      expect(provider.provide).toBe(dbConfig.KEY);
      expect(provider.useFactory).toBe(dbConfig.factory);
      expect(provider.inject).toEqual([CONFIG_ENV]);
    });
  });

  describe('CONFIG_ENV', () => {
    it('defaults to {} when no adapter provides it, so factories still resolve', async () => {
      @Module({ imports: [ConfigModule.forRoot({ load: [dbConfig], isGlobal: true })] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const cfg = app.get(ConfigService);

      expect(app.get(CONFIG_ENV)).toEqual({});
      // env was {} → factory fell back to its defaults
      expect(cfg.get('database.url')).toBe('sqlite::memory:');
      expect(cfg.get('database.pool')).toBe(10);
    });

    it('is overridable — a namespace factory reads the seeded env', async () => {
      @Module({
        imports: [
          seedEnv({ DATABASE_URL: 'postgres://db/app', MAIL_FROM: 'hi@app.dev' }),
          ConfigModule.forRoot({ load: [dbConfig, mailConfig], isGlobal: true }),
        ],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const cfg = app.get(ConfigService);

      expect(cfg.get('database.url')).toBe('postgres://db/app');
      expect(cfg.get('mail.from')).toBe('hi@app.dev');
    });
  });

  describe('merged dot-notation access', () => {
    it('reads namespaced values via ns.key dot-notation and whole namespaces', async () => {
      @Module({
        imports: [
          seedEnv({ DATABASE_URL: 'pg://x' }),
          ConfigModule.forRoot({ load: [dbConfig, mailConfig], isGlobal: true }),
        ],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const cfg = app.get(ConfigService);

      expect(cfg.get('database.url')).toBe('pg://x');
      expect(cfg.get('database.pool')).toBe(10);
      expect(cfg.get('mail.from')).toBe('noreply@example.com');
      expect(cfg.get('database')).toEqual({ url: 'pg://x', pool: 10 });
    });

    it('getOrThrow throws on a missing key; has() reflects presence', async () => {
      @Module({
        imports: [seedEnv({ DATABASE_URL: 'x' }), ConfigModule.forRoot({ load: [dbConfig], isGlobal: true })],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const cfg = app.get(ConfigService);

      expect(cfg.has('database.url')).toBe(true);
      expect(cfg.has('database.nope')).toBe(false);
      expect(cfg.getOrThrow('database.url')).toBe('x');
      expect(() => cfg.getOrThrow('database.nope')).toThrow(/database\.nope/);
    });

    it('all() returns the merged flat-config + namespaces object', async () => {
      @Module({
        imports: [
          seedEnv({ DATABASE_URL: 'pg://x' }),
          ConfigModule.forRoot({ config: { port: 8080 }, load: [dbConfig], isGlobal: true }),
        ],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const cfg = app.get(ConfigService);

      expect(cfg.getAll()).toEqual({ port: 8080, database: { url: 'pg://x', pool: 10 } });
    });
  });

  describe('namespace-token injection', () => {
    it('injects a namespace value directly via its KEY', async () => {
      @Injectable()
      class DbClient {
        constructor(@Inject(dbConfig.KEY) readonly db: InferConfigType<typeof dbConfig>) {}
      }

      @Module({
        imports: [seedEnv({ DATABASE_URL: 'mysql://h/db' }), ConfigModule.forRoot({ load: [dbConfig] })],
        providers: [DbClient],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      expect(app.get(DbClient).db).toEqual({ url: 'mysql://h/db', pool: 10 });
    });
  });

  describe('lazy namespace resolution', () => {
    it('runs a namespace factory only on its first read — not at bootstrap, not on app.get(ConfigService)', async () => {
      let calls = 0;
      const spyNs = registerAs('spy', (env: TestEnv) => {
        calls++;
        return { url: env.DATABASE_URL ?? 'fallback' };
      });

      @Module({
        imports: [seedEnv({ DATABASE_URL: 'z' }), ConfigModule.forRoot({ load: [spyNs], isGlobal: true })],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      // The KEY provider lives in ConfigModule's lazy sub-module — not
      // materialized at bootstrap.
      expect(calls).toBe(0);

      // ConfigModule is EAGER, so this returns the already-constructed
      // ConfigService singleton; it does NOT drag in the lazy namespace group.
      const cfg = app.get(ConfigService);
      expect(calls).toBe(0);

      // First read of the namespace resolves its KEY through the container,
      // claiming + sync-draining the lazy sub-module → factory runs exactly once.
      expect(cfg.get('spy.url')).toBe('z');
      expect(calls).toBe(1);

      // Second read is served from the ConfigStore cache — no re-run.
      expect(cfg.get('spy.url')).toBe('z');
      expect(calls).toBe(1);
    });

    it('resolves ConfigService synchronously after a genuinely async forRootAsync factory (eager module)', async () => {
      // Regression: ConfigModule must stay eager so an async `useFactory`
      // resolves in the awaited bootstrap pass and a *synchronous*
      // app.get(ConfigService) afterwards returns the cached singleton — a
      // module-level `lazy: true` would force the sync seam to drain the async
      // options factory and throw.
      @Module({
        imports: [
          ConfigModule.forRootAsync({
            useFactory: async () => {
              await Promise.resolve();
              return { config: { APP_NAME: 'async-app', nested: { n: 1 } } };
            },
            isGlobal: true,
          }),
        ],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const cfg = app.get(ConfigService); // sync, post-bootstrap — must not throw
      expect(cfg.get('APP_NAME')).toBe('async-app');
      expect(cfg.get('nested.n')).toBe(1);
    });

    it('ConfigStore resolves a namespace via the container once, then caches', () => {
      const ns = registerAs('svc', (env: TestEnv) => ({ url: env.DATABASE_URL }));
      let resolves = 0;
      const fakeContainer = {
        resolve: (_token: unknown) => {
          resolves++;
          return { url: 'from-container' };
        },
      };

      const store = new ConfigStore(fakeContainer, {}, [ns]);
      expect(resolves).toBe(0); // constructing the store resolves nothing
      expect(store.get('svc.url')).toBe('from-container');
      expect(resolves).toBe(1);
      expect(store.get('svc.url')).toBe('from-container');
      expect(resolves).toBe(1); // cached — no second container round-trip
    });
  });

  describe('validateSchema', () => {
    it('rejects the merged config when the schema throws (zod-like parse)', async () => {
      const schema = {
        parse(cfg: Record<string, unknown>) {
          const db = cfg.database as { pool: number };
          if (db.pool !== 5) throw new Error('database.pool must be 5');
          return cfg;
        },
      };

      @Module({
        imports: [
          seedEnv({ DATABASE_URL: 'x' }),
          ConfigModule.forRoot({ load: [dbConfig], validateSchema: schema, isGlobal: true }),
        ],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const cfg = app.get(ConfigService);
      // dbConfig.pool is 10, schema wants 5 → first read triggers validation
      expect(() => cfg.get('database.url')).toThrow('database.pool must be 5');
    });

    it('accepts a valid merged config (schema as a function)', async () => {
      const schema = (cfg: Record<string, unknown>) => {
        const db = cfg.database as { pool: number };
        if (db.pool !== 10) throw new Error('unexpected pool');
        return cfg;
      };

      @Module({
        imports: [
          seedEnv({ DATABASE_URL: 'ok' }),
          ConfigModule.forRoot({ load: [dbConfig], validateSchema: schema, isGlobal: true }),
        ],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const cfg = app.get(ConfigService);
      expect(cfg.get('database.url')).toBe('ok');
    });
  });

  describe('back-compat', () => {
    it('keeps the flat config / CONFIG_OPTIONS path working alongside namespaces', async () => {
      @Module({
        imports: [
          seedEnv({ DATABASE_URL: 'pg://x' }),
          ConfigModule.forRoot({ config: { port: 8080, nested: { a: 1 } }, load: [dbConfig], isGlobal: true }),
        ],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const cfg = app.get(ConfigService);

      expect(cfg.get('port')).toBe(8080);
      expect(cfg.get('nested.a')).toBe(1);
      expect(cfg.get('database.url')).toBe('pg://x');
      expect(app.get(CONFIG_OPTIONS)).toEqual({ port: 8080, nested: { a: 1 } });
    });

    it('ConfigType<> gives a typed shape usable as the ConfigService generic', async () => {
      @Module({
        imports: [seedEnv({ DATABASE_URL: 'pg://x' }), ConfigModule.forRoot({ load: [dbConfig], isGlobal: true })],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const cfg = app.get(ConfigService) as ConfigService<ConfigType<[typeof dbConfig]>>;
      const url: string = cfg.getOrThrow('database.url');
      const pool: number = cfg.getOrThrow('database.pool');
      expect(url).toBe('pg://x');
      expect(pool).toBe(10);
    });
  });
});
