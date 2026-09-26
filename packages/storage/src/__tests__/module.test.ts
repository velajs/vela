import { Test } from '@velajs/testing';
import {
  Module,
  InjectionToken,
  defineProvider,
  VelaFactory,
  type DynamicModule,
  type VelaApplication,
  type VelaEnv,
} from '@velajs/vela';
import { describe, expect, it, vi } from 'vitest';
import { StorageModule, StorageService, storageToken, type StorageModuleOptions } from '../index';
import { memoryDriver } from '../drivers/memory';

/** An application importing `imports`, with wiring problems failing bootstrap. */
function appWith(imports: DynamicModule[]): Promise<VelaApplication> {
  class Root {}
  Module({ imports })(Root);
  return VelaFactory.create(Root, { diagnostics: 'throw' });
}

describe('StorageModule', () => {
  it('does not let explicit keys bypass bucket name uniqueness', async () => {
    await expect(
      appWith([
        StorageModule.register({ name: 'uploads', key: 'first', driver: memoryDriver() }),
        StorageModule.register({ name: 'uploads', key: 'second', driver: memoryDriver() }),
      ]),
    ).rejects.toThrow("duplicate bucket registration 'uploads'");
  });

  it('mounts only explicit controller declarations and resolves HTTP policy through DI', async () => {
    const POLICY = new InjectionToken<{ allowed: boolean }>('storage test policy');
    @Module({
      providers: [defineProvider(POLICY, { useValue: { allowed: true } })],
      exports: [POLICY],
    })
    class Policy {}
    const driver = memoryDriver({ initial: { 'hello.txt': 'hello' } });
    const app = await appWith([
      StorageModule.registerAsync({
        name: 'runtime',
        httpController: { path: '/runtime' },
        imports: [Policy],
        inject: [POLICY],
        useFactory: async (policy) => ({
          driver,
          http: { authorize: () => policy.allowed, download: 'proxy' as const },
        }),
      }),
      StorageModule.register({ name: 'hidden', driver, http: { authorize: () => true } }),
      StorageModule.register({
        name: 'disabled',
        driver,
        httpController: false,
        http: { authorize: () => true },
      }),
    ]);
    try {
      const response = await app.getHonoApp().request('/runtime/download?key=hello.txt');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('hello');
      expect((await app.getHonoApp().request('/api/storage/download?key=hello.txt')).status).toBe(
        404,
      );
    } finally {
      await app.close();
    }
  });

  it('forRoot provides a working StorageService', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StorageModule.register({ driver: memoryDriver() })],
    }).compile();

    const svc = moduleRef.get(StorageService);
    const res = await svc.upload('a/b.txt', 'hello');
    expect(res.key).toBe('a/b.txt');
    expect(res.size).toBe(5);

    const file = await svc.download('a/b.txt');
    expect(await file.text()).toBe('hello');
    expect(await svc.exists('a/b.txt')).toBe(true);
    expect(await svc.exists('missing')).toBe(false);
  });

  it('reports distinct security-sensitive registrations of one bucket instead of merging them', async () => {
    const driverA = memoryDriver();
    const driverB = memoryDriver();
    const authorizeA = () => true;
    const authorizeB = () => true;
    const register = (overrides: Partial<StorageModuleOptions> = {}) =>
      StorageModule.register({
        driver: driverA,
        http: { authorize: authorizeA, multipartGrantSecret: 'a'.repeat(32) },
        ...overrides,
      });

    const first = register();
    // One bucket name is one instance key; the key never carries a secret.
    expect(first.key).toBe('default');
    const conflicting = [
      register({ driver: driverB }),
      register({ http: { authorize: authorizeB, multipartGrantSecret: 'a'.repeat(32) } }),
      register({ http: { authorize: authorizeA, multipartGrantSecret: 'b'.repeat(32) } }),
    ];
    for (const other of conflicting) {
      expect(other.key).toBe(first.key);
      await expect(appWith([first, other])).rejects.toThrow(
        /StorageModule#default was imported again with different options/,
      );
    }

    const app = await appWith([first, register()]);
    expect(app.get(StorageService)).toBeInstanceOf(StorageService);
    await app.close();
  });

  it('fails bootstrap when two features register the default bucket with different drivers', async () => {
    const privateDriver = memoryDriver({ initial: { 'secret.txt': 'private' } });
    const publicDriver = memoryDriver();
    @Module({
      imports: [
        StorageModule.register({
          driver: privateDriver,
          httpController: { path: '/files' },
          http: { authorize: () => false },
        }),
      ],
    })
    class PrivateFeature {}
    @Module({
      imports: [
        StorageModule.register({
          driver: publicDriver,
          httpController: { path: '/public' },
          http: { authorize: () => true },
        }),
      ],
    })
    class PublicFeature {}
    @Module({ imports: [PrivateFeature, PublicFeature] })
    class App {}

    // Under the default diagnostics policy, keeping the first bucket would
    // serve it through the second feature's routes and authorizer.
    await expect(VelaFactory.create(App)).rejects.toThrow(
      /StorageModule#default was imported again with different options/,
    );
  });

  it('fails bootstrap when a second feature also asks for a global bucket, in either order', async () => {
    const privateBucket = StorageModule.register({
      driver: memoryDriver({ initial: { 'secret.txt': 'private' } }),
      httpController: { path: '/files' },
    });
    const publicBucket = StorageModule.register({
      driver: memoryDriver(),
      isGlobal: true,
      httpController: { path: '/public' },
    });
    for (const [first, second] of [
      [privateBucket, publicBucket],
      [publicBucket, privateBucket],
    ]) {
      @Module({ imports: [first] })
      class FeatureA {}
      @Module({ imports: [second] })
      class FeatureB {}
      @Module({ imports: [FeatureA, FeatureB] })
      class App {}
      // A global flag that differs too never lets one feature write into the
      // other's driver, whatever the diagnostics policy.
      for (const diagnostics of ['throw', 'log', 'silent'] as const) {
        await expect(VelaFactory.create(App, { diagnostics })).rejects.toThrow(
          /StorageModule#default was imported again with different options/,
        );
      }
    }
  });

  it('reports a registration that differs only in its global flag', async () => {
    const driver = memoryDriver();
    const authorize = () => true;
    const local = StorageModule.register({
      driver,
      httpController: { path: '/files' },
      http: { authorize },
    });
    const global = StorageModule.register({
      driver,
      isGlobal: true,
      httpController: { path: '/files' },
      http: { authorize },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const imports of [
        [local, global],
        [global, local],
      ]) {
        await expect(appWith(imports)).rejects.toThrow(
          /StorageModule#default was imported again with a different global flag/,
        );
        warn.mockClear();
        class Root {}
        Module({ imports })(Root);
        const app = await VelaFactory.create(Root);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/different global flag/));
        expect(app.get(StorageService)).toBeInstanceOf(StorageService);
        await app.close();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it('treats an extra at its default and an undefined option as absent', async () => {
    const driver = memoryDriver();
    const app = await appWith([
      StorageModule.register({ driver }),
      StorageModule.register({ driver, isGlobal: false }),
      StorageModule.register({ driver, prefix: undefined }),
    ]);
    expect(app.getContainer().getOwnerModuleIds(StorageService)).toEqual(['StorageModule#default']);
    await app.close();
  });

  it('treats the default bucket name spelled out as the default bucket', async () => {
    const driver = memoryDriver();
    const app = await appWith([
      StorageModule.register({ driver }),
      StorageModule.register({ driver, name: 'default' }),
    ]);
    expect(app.getContainer().getOwnerModuleIds(StorageService)).toEqual(['StorageModule#default']);
    await app.close();
  });

  it('mounts the routes of an identical repeated registration once', async () => {
    const driver = memoryDriver();
    const authorize = () => true;
    const register = () =>
      StorageModule.register({ driver, httpController: { path: '/files' }, http: { authorize } });
    const app = await appWith([register(), register()]);
    const routes = app
      .describeRoutes()
      .filter((route) => route.path.startsWith('/files'))
      .map((route) => `${route.method} ${route.path}`);
    expect(routes.length).toBeGreaterThan(0);
    expect(new Set(routes).size).toBe(routes.length);
    await app.close();
  });

  it('reports a second async factory for one bucket', async () => {
    const factoryA = () => ({ driver: memoryDriver() });
    const factoryB = () => ({ driver: memoryDriver() });
    const first = StorageModule.registerAsync({ useFactory: factoryA });
    const same = StorageModule.registerAsync({ useFactory: factoryA });
    const other = StorageModule.registerAsync({ useFactory: factoryB });

    expect(same.key).toBe(first.key);
    expect(other.key).toBe(first.key);
    await expect(appWith([first, other])).rejects.toThrow(
      /was imported again with different options/,
    );
    const app = await appWith([first, same]);
    await app.close();
  });

  it('rejects a driver factory that declares parameters but no inject', () => {
    expect(() =>
      StorageModule.registerAsync({
        // @ts-expect-error A factory with parameters names the tokens that supply them.
        useFactory: (bucket: string) => ({ driver: memoryDriver({ initial: { bucket } }) }),
      }),
    ).toThrow(/StorageModule\.registerAsync: useFactory declares parameters but no inject tokens/);
  });

  it('builds a driver function lazily (edge-binding safe)', async () => {
    let calls = 0;
    const moduleRef = await Test.createTestingModule({
      imports: [
        StorageModule.registerAsync({
          useFactory: () => ({
            driver: () => {
              calls += 1;
              return memoryDriver();
            },
          }),
        }),
      ],
    }).compile();

    expect(calls).toBe(0); // not built at bootstrap
    const svc = moduleRef.get(StorageService);
    expect(calls).toBe(0); // not built on service construction

    await svc.upload('x', 'y'); // first operation triggers the build
    expect(calls).toBe(1);
    await svc.download('x');
    expect(calls).toBe(1); // cached
  });

  it('runs a driver function again on the next operation until it succeeds', async () => {
    let calls = 0;
    const moduleRef = await Test.createTestingModule({
      imports: [
        StorageModule.register({
          driver: () => {
            calls += 1;
            if (calls === 1) throw new Error('binding not ready');
            return memoryDriver();
          },
        }),
      ],
    }).compile();

    const svc = moduleRef.get(StorageService);
    await expect(svc.upload('x', 'y')).rejects.toThrow('binding not ready');
    expect(calls).toBe(1);
    await svc.upload('x', 'y');
    expect(calls).toBe(2);
    await svc.download('x');
    expect(calls).toBe(2); // cached once it succeeds
  });

  it('builds a static driver factory from each application ENV on first use', async () => {
    const seen: VelaEnv[] = [];
    // One static module graph; each application passes its own ENV to the factory.
    const storage = StorageModule.register({
      driver: (env: VelaEnv) => {
        seen.push(env);
        return memoryDriver({ initial: { origin: String(Reflect.get(env, 'REGION')) } });
      },
    });
    @Module({ imports: [storage] })
    class Root {}
    const east = await VelaFactory.create(Root, { env: { REGION: 'east' } });
    const west = await VelaFactory.create(Root, { env: { REGION: 'west' } });
    expect(seen).toEqual([]);

    const read = async (app: VelaApplication) =>
      (await app.get(StorageService).download('origin')).text();
    expect(await read(east)).toBe('east');
    expect(await read(west)).toBe('west');
    expect(seen.map((env) => Reflect.get(env, 'REGION'))).toEqual(['east', 'west']);
    await Promise.all([east.close(), west.close()]);
  });

  it('supports multiple named buckets deduped by name', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        StorageModule.register({ driver: memoryDriver() }),
        StorageModule.register({ name: 'backups', driver: memoryDriver() }),
      ],
    }).compile();

    const def = moduleRef.get(StorageService);
    const backups = moduleRef.get(storageToken('backups'));

    await def.upload('k', 'in-default');
    await backups.upload('k', 'in-backups');

    expect(await (await def.download('k')).text()).toBe('in-default');
    expect(await (await backups.download('k')).text()).toBe('in-backups');
    expect(def).not.toBe(backups);
  });

  it('applies a prefix that is transparent to callers', async () => {
    const driver = memoryDriver();
    const moduleRef = await Test.createTestingModule({
      imports: [StorageModule.register({ driver, prefix: 'tenant-1' })],
    }).compile();

    const svc = moduleRef.get(StorageService);
    await svc.upload('avatar.png', 'x');

    // Stored under the prefix...
    expect(driver.raw.has('tenant-1/avatar.png')).toBe(true);
    // ...but the caller sees the logical key.
    const file = await svc.download('avatar.png');
    expect(file.key).toBe('avatar.png');
  });

  it('overrideProvider(StorageService).useValue(stub) swaps the surface', async () => {
    const stub = new StorageService(() => memoryDriver(), { name: 'test' });
    vi.spyOn(stub, 'upload').mockResolvedValue({ key: 'k', size: 1, contentType: 'x' });
    const moduleRef = await Test.createTestingModule({
      imports: [StorageModule.register({ driver: memoryDriver() })],
    })
      .overrideProvider(StorageService)
      .useValue(stub)
      .compile();

    expect(moduleRef.get(StorageService)).toBe(stub);
  });
});
