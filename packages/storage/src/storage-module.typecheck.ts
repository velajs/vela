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
      return memoryDriver();
    },
  });
  StorageModule.forRootAsync({ useFactory: () => memoryDriver() });
  StorageModule.forRootAsync({
    inject: [SECRET],
    useFactory: (secret) => ({ driver: memoryDriver(), multipartGrantSecret: secret }),
  });
  StorageModule.forRootAsync({
    // @ts-expect-error A multipart grant secret is a string or bytes.
    useFactory: () => ({ driver: memoryDriver(), multipartGrantSecret: 42 }),
  });
  // @ts-expect-error A declared dependency tuple requires runtime injection tokens.
  StorageModule.forRootAsync<readonly [typeof SECRET]>({ useFactory: () => memoryDriver() });
  StorageModule.forRootAsync({
    // @ts-expect-error A factory with parameters names the tokens that supply them.
    useFactory: (secret: string) => memoryDriver({ initial: { secret } }),
  });
}
