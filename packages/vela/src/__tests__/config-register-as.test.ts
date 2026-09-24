import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  defineProvider,
  VelaFactory,
  Module,
  Injectable,
  Inject,
  InjectionToken,
  ConfigModule,
  ConfigService,
  registerAs,
  type ConfigShape,
  type ConfigType,
  type VelaEnv,
} from '../index.js';
import { ConfigStore, CONFIG_OPTIONS } from '../internal.js';
import { Container } from '../module-kit.js';

/** Validate one synthetic string binding, as a namespace factory should. */
function binding(env: VelaEnv, key: string): string | undefined {
  const value: unknown = Reflect.get(env, key);
  return typeof value === 'string' ? value : undefined;
}

const dbConfig = registerAs('database', (env) => ({
  url: binding(env, 'DATABASE_URL') ?? 'sqlite::memory:',
  pool: 10,
}));

const mailConfig = registerAs('mail', (env) => ({
  from: binding(env, 'MAIL_FROM') ?? 'noreply@example.com',
}));

/** The merged config's database pool, read without trusting its shape. */
function poolOf(config: Record<string, unknown>): unknown {
  const database: unknown = config.database;
  return typeof database === 'object' && database !== null
    ? Reflect.get(database, 'pool')
    : undefined;
}

describe('registerAs config namespaces', () => {
  describe('registerAs()', () => {
    it('creates a concrete typed token and captures namespace + factory', () => {
      expect(dbConfig.KEY).toBeInstanceOf(InjectionToken);
      expect(dbConfig.namespace).toBe('database');
      expect(dbConfig.factory({ DATABASE_URL: 'x' })).toEqual({ url: 'x', pool: 10 });
      expectTypeOf(dbConfig.KEY).toEqualTypeOf<InjectionToken<{ url: string; pool: number }>>();
    });

    it('takes the namespace and a factory of the framework ENV', () => {
      expectTypeOf(registerAs<'x', { a: 1 }>)
        .parameter(1)
        .toEqualTypeOf<(env: VelaEnv) => { a: 1 }>();
      // @ts-expect-error the environment comes from ENV, not a caller-supplied token
      registerAs('legacy', new InjectionToken<object>('env'), () => ({}));
    });

    it('asProvider() registers the namespace KEY', () => {
      expect(dbConfig.asProvider().provide).toBe(dbConfig.KEY);
    });
  });

  describe('ENV', () => {
    it('fails a namespace read with a clear error when no runtime seeded ENV', async () => {
      @Module({ imports: [ConfigModule.forRoot({ load: [dbConfig], isGlobal: true })] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const cfg = app.get(ConfigService);

      expect(() => cfg.get('database.url')).toThrow(
        /registerAs\('database'\) reads ENV, but no runtime seeded it/,
      );
    });

    it('feeds the seeded environment to namespace factories', async () => {
      @Module({
        imports: [ConfigModule.forRoot({ load: [dbConfig, mailConfig], isGlobal: true })],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule, {
        env: { DATABASE_URL: 'postgres://db/app', MAIL_FROM: 'hi@app.dev' },
      });
      const cfg = app.get(ConfigService);

      expect(cfg.get('database.url')).toBe('postgres://db/app');
      expect(cfg.get('mail.from')).toBe('hi@app.dev');
    });

    it('builds each application from its own environment', async () => {
      @Module({ imports: [ConfigModule.forRoot({ load: [dbConfig], isGlobal: true })] })
      class AppModule {}

      const a = await VelaFactory.create(AppModule, { env: { DATABASE_URL: 'pg://a' } });
      const b = await VelaFactory.create(AppModule, { env: { DATABASE_URL: 'pg://b' } });

      expect(a.get(ConfigService).get('database.url')).toBe('pg://a');
      expect(b.get(ConfigService).get('database.url')).toBe('pg://b');
    });
  });

  describe('merged dot-notation access', () => {
    it('reads namespaced values via ns.key dot-notation and whole namespaces', async () => {
      @Module({
        imports: [ConfigModule.forRoot({ load: [dbConfig, mailConfig], isGlobal: true })],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule, { env: { DATABASE_URL: 'pg://x' } });
      const cfg = app.get(ConfigService);

      expect(cfg.get('database.url')).toBe('pg://x');
      expect(cfg.get('database.pool')).toBe(10);
      expect(cfg.get('mail.from')).toBe('noreply@example.com');
      expect(cfg.get('database')).toEqual({ url: 'pg://x', pool: 10 });
    });

    it('getOrThrow throws on a missing key; has() reflects presence', async () => {
      @Module({ imports: [ConfigModule.forRoot({ load: [dbConfig], isGlobal: true })] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule, { env: { DATABASE_URL: 'x' } });
      const cfg = app.get(ConfigService);

      expect(cfg.has('database.url')).toBe(true);
      expect(cfg.has('database.nope')).toBe(false);
      expect(cfg.getOrThrow('database.url')).toBe('x');
      expect(() => cfg.getOrThrow('database.nope')).toThrow(/database\.nope/);
    });

    it('all() returns the merged flat-config + namespaces object', async () => {
      @Module({
        imports: [
          ConfigModule.forRoot({ config: { port: 8080 }, load: [dbConfig], isGlobal: true }),
        ],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule, { env: { DATABASE_URL: 'pg://x' } });
      const cfg = app.get(ConfigService);

      expect(cfg.getAll()).toEqual({ port: 8080, database: { url: 'pg://x', pool: 10 } });
    });
  });

  describe('namespace-token injection', () => {
    it('injects a namespace value directly via its KEY', async () => {
      @Injectable()
      class DbClient {
        constructor(@Inject(dbConfig.KEY) readonly db: ConfigType<typeof dbConfig>) {}
      }

      @Module({ imports: [ConfigModule.forRoot({ load: [dbConfig] })], providers: [DbClient] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule, { env: { DATABASE_URL: 'mysql://h/db' } });
      expect(app.get(DbClient).db).toEqual({ url: 'mysql://h/db', pool: 10 });
      expectTypeOf(app.get(DbClient).db).toEqualTypeOf<{ url: string; pool: number }>();
    });
  });

  describe('ConfigModule.forFeature()', () => {
    it('provides a namespace to the importing module and to ConfigService', async () => {
      let calls = 0;
      const featureConfig = registerAs('feature', (env) => {
        calls++;
        return { flag: binding(env, 'FEATURE_FLAG') ?? 'off' };
      });

      @Injectable()
      class FeatureService {
        constructor(
          @Inject(featureConfig.KEY) readonly config: ConfigType<typeof featureConfig>,
          @Inject(ConfigService) readonly all: ConfigService<ConfigShape<[typeof featureConfig]>>,
        ) {}
      }
      @Module({ imports: [ConfigModule.forFeature(featureConfig)], providers: [FeatureService] })
      class FeatureModule {}
      @Module({ imports: [ConfigModule.forRoot({ isGlobal: true }), FeatureModule] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule, { env: { FEATURE_FLAG: 'on' } });
      const service = app.get(FeatureService);

      expect(service.config).toEqual({ flag: 'on' });
      expect(service.all.get('feature.flag')).toBe('on');
      expect(app.get(ConfigService).get('feature')).toEqual({ flag: 'on' });
      expect(calls).toBe(1);
    });

    it('keeps the namespace factory lazy until the first read', async () => {
      let calls = 0;
      const lazyConfig = registerAs('lazy', () => {
        calls++;
        return { ready: true };
      });
      @Module({
        imports: [ConfigModule.forRoot({ isGlobal: true }), ConfigModule.forFeature(lazyConfig)],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule, { env: {} });
      expect(calls).toBe(0);
      expect(app.get(ConfigService).get('lazy.ready')).toBe(true);
      expect(calls).toBe(1);
    });

    it('shares one KEY owner with a global forRoot load of the same namespace', async () => {
      let calls = 0;
      const sharedConfig = registerAs('shared', (env) => {
        calls++;
        return { region: binding(env, 'SHARED_REGION') ?? 'none' };
      });

      @Injectable()
      class SharedReader {
        constructor(@Inject(sharedConfig.KEY) readonly config: ConfigType<typeof sharedConfig>) {}
      }
      @Module({ imports: [ConfigModule.forFeature(sharedConfig)], providers: [SharedReader] })
      class FeatureModule {}
      @Module({
        imports: [ConfigModule.forRoot({ isGlobal: true, load: [sharedConfig] }), FeatureModule],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule, {
        diagnostics: 'throw',
        env: { SHARED_REGION: 'eu' },
      });
      const reader = app.get(SharedReader);

      expect(reader.config).toEqual({ region: 'eu' });
      expect(app.get(ConfigService).get('shared')).toBe(reader.config);
      expect(app.getContainer().getOwnerModuleIds(sharedConfig.KEY)).toHaveLength(1);
      expect(calls).toBe(1);
    });

    it('runs the namespace factory once when forRoot and forFeature both load it', async () => {
      let calls = 0;
      const sharedConfig = registerAs('shared', () => {
        calls++;
        return { ready: true };
      });

      @Injectable()
      class SharedReader {
        constructor(@Inject(sharedConfig.KEY) readonly config: ConfigType<typeof sharedConfig>) {}
      }
      @Module({ imports: [ConfigModule.forFeature(sharedConfig)], providers: [SharedReader] })
      class FeatureModule {}
      @Module({ imports: [ConfigModule.forRoot({ load: [sharedConfig] }), FeatureModule] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule, { diagnostics: 'throw', env: {} });

      expect(app.get(SharedReader).config).toBe(app.get(ConfigService).get('shared'));
      expect(app.getContainer().getOwnerModuleIds(sharedConfig.KEY)).toHaveLength(1);
      expect(calls).toBe(1);
    });

    it('reports another namespace object registered under the same name', async () => {
      const first = registerAs('duplicate', () => ({ source: 'first' }));
      const second = registerAs('duplicate', () => ({ source: 'second' }));
      @Module({ imports: [ConfigModule.forFeature(second)] })
      class FeatureModule {}
      @Module({ imports: [ConfigModule.forRoot({ isGlobal: true, load: [first] }), FeatureModule] })
      class AppModule {}

      await expect(
        VelaFactory.create(AppModule, { diagnostics: 'throw', env: {} }),
      ).rejects.toThrow(/was imported again with different options/);
    });
  });

  describe('lazy namespace resolution', () => {
    it('runs a namespace factory only on its first read — not at bootstrap, not on app.get(ConfigService)', async () => {
      let calls = 0;
      const spyNs = registerAs('spy', (env) => {
        calls++;
        return { url: binding(env, 'DATABASE_URL') ?? 'fallback' };
      });

      @Module({ imports: [ConfigModule.forRoot({ load: [spyNs], isGlobal: true })] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule, { env: { DATABASE_URL: 'z' } });
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
            inject: [],
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
      const ns = registerAs('svc', (env) => ({ url: binding(env, 'DATABASE_URL') }));
      const container = new Container().register(
        defineProvider(ns.KEY, { useValue: { url: 'from-container' } }),
      );
      let resolves = 0;
      const countingContainer: Pick<Container, 'resolve'> = {
        resolve: (token, requestingModuleId) => {
          resolves++;
          return container.resolve(token, requestingModuleId);
        },
      };

      const store = new ConfigStore(countingContainer, {}, [ns]);
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
        parse(cfg: unknown) {
          if (typeof cfg !== 'object' || cfg === null) throw new Error('config must be an object');
          if (poolOf({ ...cfg }) !== 5) throw new Error('database.pool must be 5');
          return cfg;
        },
      };

      @Module({
        imports: [
          ConfigModule.forRoot({ load: [dbConfig], validateSchema: schema, isGlobal: true }),
        ],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule, { env: { DATABASE_URL: 'x' } });
      const cfg = app.get(ConfigService);
      // dbConfig.pool is 10, schema wants 5 → first read triggers validation
      expect(() => cfg.get('database.url')).toThrow('database.pool must be 5');
    });

    it('accepts a valid merged config (schema as a function)', async () => {
      const schema = (cfg: Record<string, unknown>) => {
        if (poolOf(cfg) !== 10) throw new Error('unexpected pool');
        return cfg;
      };

      @Module({
        imports: [
          ConfigModule.forRoot({ load: [dbConfig], validateSchema: schema, isGlobal: true }),
        ],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule, { env: { DATABASE_URL: 'ok' } });
      const cfg = app.get(ConfigService);
      expect(cfg.get('database.url')).toBe('ok');
    });
  });

  describe('back-compat', () => {
    it('keeps the flat config / CONFIG_OPTIONS path working alongside namespaces', async () => {
      @Module({
        imports: [
          ConfigModule.forRoot({
            config: { port: 8080, nested: { a: 1 } },
            load: [dbConfig],
            isGlobal: true,
          }),
        ],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule, { env: { DATABASE_URL: 'pg://x' } });
      const cfg = app.get(ConfigService);

      expect(cfg.get('port')).toBe(8080);
      expect(cfg.get('nested.a')).toBe(1);
      expect(cfg.get('database.url')).toBe('pg://x');
      expect(app.get(CONFIG_OPTIONS)).toEqual({ port: 8080, nested: { a: 1 } });
    });

    it('ConfigShape<> types the ConfigService generic from loaded namespaces', async () => {
      @Injectable()
      class Reader {
        constructor(
          @Inject(ConfigService)
          readonly cfg: ConfigService<ConfigShape<[typeof dbConfig, typeof mailConfig]>>,
        ) {}
      }
      @Module({
        imports: [ConfigModule.forRoot({ load: [dbConfig, mailConfig], isGlobal: true })],
        providers: [Reader],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule, { env: { DATABASE_URL: 'pg://x' } });
      const { cfg } = app.get(Reader);
      const url: string = cfg.getOrThrow('database.url');
      const pool: number = cfg.getOrThrow('database.pool');
      expectTypeOf(cfg.get('mail.from')).toEqualTypeOf<string | undefined>();
      expectTypeOf(cfg.getOrThrow('database')).toEqualTypeOf<{ url: string; pool: number }>();
      // @ts-expect-error paths come from the loaded namespace shapes
      cfg.get('database.missing');
      expect(url).toBe('pg://x');
      expect(pool).toBe(10);
    });
  });
});
