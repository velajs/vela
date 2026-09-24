import { Test } from '@velajs/testing';
import { Module, VelaFactory, type DynamicModule, type VelaApplication } from '@velajs/vela';
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
  it('forRoot provides a working StorageService', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StorageModule.forRoot({ driver: memoryDriver() })],
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
      StorageModule.forRoot({
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

  it('reports a second async factory for one bucket', async () => {
    const factoryA = () => ({ driver: memoryDriver() });
    const factoryB = () => ({ driver: memoryDriver() });
    const first = StorageModule.forRootAsync({ useFactory: factoryA });
    const same = StorageModule.forRootAsync({ useFactory: factoryA });
    const other = StorageModule.forRootAsync({ useFactory: factoryB });

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
      StorageModule.forRootAsync({
        // @ts-expect-error A factory with parameters names the tokens that supply them.
        useFactory: (bucket: string) => ({ driver: memoryDriver({ initial: { bucket } }) }),
      }),
    ).toThrow(/StorageModule\.forRootAsync: useFactory declares parameters but no inject tokens/);
  });

  it('builds a driver function lazily (edge-binding safe)', async () => {
    let calls = 0;
    const moduleRef = await Test.createTestingModule({
      imports: [
        StorageModule.forRootAsync({
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
        StorageModule.forRoot({
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

  it('supports multiple named buckets deduped by name', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        StorageModule.forRoot({ driver: memoryDriver() }),
        StorageModule.forRoot({ name: 'backups', driver: memoryDriver() }),
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
      imports: [StorageModule.forRoot({ driver, prefix: 'tenant-1' })],
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
      imports: [StorageModule.forRoot({ driver: memoryDriver() })],
    })
      .overrideProvider(StorageService)
      .useValue(stub)
      .compile();

    expect(moduleRef.get(StorageService)).toBe(stub);
  });
});
