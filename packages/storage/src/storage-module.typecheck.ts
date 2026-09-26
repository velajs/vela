import { InjectionToken } from '@velajs/vela';
import { StorageModule } from './storage.module';
import { memoryDriver } from './drivers/memory';

const SECRET = new InjectionToken<string>('test.secret');

export function verifyStorageFactoryDependencies(): void {
  StorageModule.register({ driver: memoryDriver(), httpController: false });
  StorageModule.register({
    driver: memoryDriver(),
    httpController: {},
    http: { authorize: () => true },
  });
  StorageModule.register({
    driver: memoryDriver(),
    // @ts-expect-error A grant secret belongs to the runtime HTTP policy.
    multipartGrantSecret: 'removed',
  });
  StorageModule.register({
    driver: memoryDriver(),
    // @ts-expect-error Route declarations use httpController.path.
    http: { basePath: '/removed' },
  });
  StorageModule.registerAsync({
    inject: [SECRET],
    useFactory: (secret) => {
      const value: string = secret;
      void value;
      return { driver: memoryDriver() };
    },
  });
  StorageModule.registerAsync({ useFactory: () => ({ driver: () => memoryDriver() }) });
  StorageModule.registerAsync({
    inject: [SECRET],
    useFactory: (secret) => ({ driver: memoryDriver(), http: { multipartGrantSecret: secret } }),
    name: 'uploads',
    httpController: { path: '/uploads' },
  });
  StorageModule.registerAsync({
    // @ts-expect-error A multipart grant secret is a string or bytes.
    useFactory: () => ({ driver: memoryDriver(), http: { multipartGrantSecret: 42 } }),
  });
  // @ts-expect-error The factory returns the module options, not a bare driver.
  StorageModule.registerAsync({ useFactory: () => memoryDriver() });
  // @ts-expect-error Non-structural options such as the prefix come from the factory.
  StorageModule.registerAsync({ useFactory: () => ({ driver: memoryDriver() }), prefix: 'a' });
  StorageModule.registerAsync<readonly [typeof SECRET]>(
    // @ts-expect-error A declared dependency tuple requires runtime injection tokens.
    { useFactory: () => ({ driver: memoryDriver() }) },
  );
  StorageModule.registerAsync({
    // @ts-expect-error A factory with parameters names the tokens that supply them.
    useFactory: (secret: string) => ({ driver: memoryDriver({ initial: { secret } }) }),
  });
}
