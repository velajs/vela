import { Test } from '@velajs/testing';
import { describe, expect, it, vi } from 'vitest';
import { StorageModule, StorageService, storageToken } from '../index';
import { memoryDriver } from '../drivers/memory';

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

  it('does not collapse distinct security-sensitive registrations with equal-looking options', () => {
    const driverA = memoryDriver();
    const driverB = memoryDriver();
    const authorizeA = () => true;
    const authorizeB = () => true;

    const first = StorageModule.forRoot({
      driver: driverA,
      http: { authorize: authorizeA, multipartGrantSecret: 'a'.repeat(32) },
    });
    const same = StorageModule.forRoot({
      driver: driverA,
      http: { authorize: authorizeA, multipartGrantSecret: 'a'.repeat(32) },
    });
    const otherDriver = StorageModule.forRoot({
      driver: driverB,
      http: { authorize: authorizeA, multipartGrantSecret: 'a'.repeat(32) },
    });
    const otherAuthorizer = StorageModule.forRoot({
      driver: driverA,
      http: { authorize: authorizeB, multipartGrantSecret: 'a'.repeat(32) },
    });
    const otherSecret = StorageModule.forRoot({
      driver: driverA,
      http: { authorize: authorizeA, multipartGrantSecret: 'b'.repeat(32) },
    });

    expect(same.key).toBe(first.key);
    expect(otherDriver.key).not.toBe(first.key);
    expect(otherAuthorizer.key).not.toBe(first.key);
    expect(otherSecret.key).not.toBe(first.key);
  });

  it('includes async factory identity in the dynamic-module key', () => {
    const factoryA = () => memoryDriver();
    const factoryB = () => memoryDriver();
    const first = StorageModule.forRootAsync({ useFactory: factoryA });
    const same = StorageModule.forRootAsync({ useFactory: factoryA });
    const other = StorageModule.forRootAsync({ useFactory: factoryB });

    expect(same.key).toBe(first.key);
    expect(other.key).not.toBe(first.key);
  });

  it('rejects a driver factory that declares parameters but no inject', () => {
    expect(() =>
      StorageModule.forRootAsync({
        // @ts-expect-error A factory with parameters names the tokens that supply them.
        useFactory: (bucket: string) => memoryDriver({ initial: { bucket } }),
      }),
    ).toThrow(/StorageModule\.forRootAsync: useFactory declares parameters but no inject tokens/);
  });

  it('forRootAsync builds the driver lazily (edge-binding safe)', async () => {
    let calls = 0;
    const moduleRef = await Test.createTestingModule({
      imports: [
        StorageModule.forRootAsync({
          useFactory: () => {
            calls += 1;
            return memoryDriver();
          },
        }),
      ],
    }).compile();

    expect(calls).toBe(0); // not built at module load
    const svc = moduleRef.get(StorageService);
    expect(calls).toBe(0); // not built on service construction

    await svc.upload('x', 'y'); // first operation triggers the build
    expect(calls).toBe(1);
    await svc.download('x');
    expect(calls).toBe(1); // cached
  });

  it('forRootAsync runs the factory again on the next operation until it succeeds', async () => {
    let calls = 0;
    const moduleRef = await Test.createTestingModule({
      imports: [
        StorageModule.forRootAsync({
          useFactory: () => {
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
