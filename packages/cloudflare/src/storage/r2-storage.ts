import type { EnvFactory } from '@velajs/vela/module-kit';
import type { StorageDriver } from '@velajs/storage';
import { r2Driver, type R2DriverOptions } from '@velajs/storage/drivers/r2';
import { r2 } from '../bindings';

/** `r2Storage` options: the bucket's binding name and the native driver's settings. */
export interface R2StorageOptions extends Omit<R2DriverOptions, 'bucket'> {
  /** The bucket's binding name, declared under `r2_buckets` in the Wrangler configuration. */
  binding: string;
}

/**
 * The native R2 driver for `@velajs/storage`, reading its bucket from the
 * application's `ENV` by name:
 *
 * ```ts
 * StorageModule.register({ driver: r2Storage({ binding: 'UPLOADS' }) })
 * ```
 *
 * `StorageModule` builds the driver on the first storage operation of each
 * application, so a static module graph serves every environment and boot
 * touches no binding. A missing or mistyped binding fails that operation with
 * a message naming the binding and `r2_buckets`. Like `r2Driver`, it cannot
 * presign uploads; serve downloads through `publicBaseUrl` or the module's
 * `http: { download: 'proxy' }` controller.
 */
export function r2Storage(options: R2StorageOptions): EnvFactory<StorageDriver<R2Bucket>> {
  const { binding, ...driver } = options;
  const bucket = r2({ binding });
  return (env) => r2Driver({ ...driver, bucket: bucket(env) });
}
