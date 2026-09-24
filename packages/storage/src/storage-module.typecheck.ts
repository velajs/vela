import { InjectionToken } from '@velajs/vela';
import { StorageModule } from './storage.module';
import { memoryDriver } from './drivers/memory';

const SECRET = new InjectionToken<string>('test.secret');

export function verifyStorageFactoryDependencies(): void {
  StorageModule.forRootAsync({
    inject: [SECRET],
    useFactory: (secret) => {
      const value: string = secret;
      void value;
      return { driver: memoryDriver() };
    },
  });
  StorageModule.forRootAsync({ useFactory: () => ({ driver: () => memoryDriver() }) });
  StorageModule.forRootAsync({
    inject: [SECRET],
    useFactory: (secret) => ({ driver: memoryDriver(), multipartGrantSecret: secret }),
    name: 'uploads',
    http: { basePath: '/uploads' },
  });
  StorageModule.forRootAsync({
    // @ts-expect-error A multipart grant secret is a string or bytes.
    useFactory: () => ({ driver: memoryDriver(), multipartGrantSecret: 42 }),
  });
  // @ts-expect-error The factory returns the module options, not a bare driver.
  StorageModule.forRootAsync({ useFactory: () => memoryDriver() });
  // @ts-expect-error Non-structural options such as the prefix come from the factory.
  StorageModule.forRootAsync({ useFactory: () => ({ driver: memoryDriver() }), prefix: 'a' });
  StorageModule.forRootAsync<readonly [typeof SECRET]>(
    // @ts-expect-error A declared dependency tuple requires runtime injection tokens.
    { useFactory: () => ({ driver: memoryDriver() }) },
  );
  StorageModule.forRootAsync({
    // @ts-expect-error A factory with parameters names the tokens that supply them.
    useFactory: (secret: string) => ({ driver: memoryDriver({ initial: { secret } }) }),
  });
}
