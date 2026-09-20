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
  // @ts-expect-error A declared dependency tuple requires runtime injection tokens.
  StorageModule.forRootAsync<readonly [typeof SECRET]>({ useFactory: () => memoryDriver() });
}
