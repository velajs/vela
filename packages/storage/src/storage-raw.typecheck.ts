import type { R2BucketLike } from './drivers/r2';

import { createStorage, type Storage } from './storage.facade';
import { StorageService, lazyDriver } from './storage.service';
import { r2Driver } from './drivers/r2';
import { r2HybridDriver } from './drivers/r2-http';
import { memoryDriver } from './drivers/memory';
import {
  cache,
  compose,
  compression,
  encryption,
  failover,
  passthrough,
  retry,
  versioning,
  type Middleware,
} from './middleware';
import type { MetadataListResult, StorageOptions } from './storage.types';

interface NativeBucket extends R2BucketLike {
  nativeMethod(): string;
}

/** Compiled, never executed: inference must retain the actual platform handle. */
export function verifyRawInference(
  bucket: NativeBucket,
  key: CryptoKey,
  page: MetadataListResult,
): void {
  const driver = r2Driver({ bucket });
  const storage = createStorage({ driver });
  const exact: NativeBucket = storage.raw;
  const readOnly: NativeBucket = storage.readonly().raw;
  const nativeMethodResult = storage.raw.nativeMethod();
  const deferred: NativeBucket = lazyDriver(() => driver).raw;
  const service: NativeBucket = new StorageService(() => driver, { name: 'native' }).storage.raw;
  const wrapped: NativeBucket = compose(
    driver,
    cache(),
    retry(),
    compression(),
    encryption({ key }),
    versioning(),
    failover([memoryDriver()]),
  ).raw;
  const delegated: NativeBucket = passthrough(driver).raw;
  const hybrid: NativeBucket = r2HybridDriver({
    binding: bucket,
    bucket: 'uploads',
    accountId: 'a',
    accessKeyId: 'k',
    secretAccessKey: 's',
  }).raw;
  const legacyAnnotation: Storage = storage;
  const legacyOptions: StorageOptions = { driver };
  const oldMiddleware: Middleware = () => memoryDriver();
  const changedRaw = compose(driver, oldMiddleware).raw;
  // @ts-expect-error Arbitrary legacy middleware can replace raw; do not invent its type.
  const unsafe: NativeBucket = changedRaw;
  // @ts-expect-error Full binding inference does not make unknown methods legal.
  storage.raw.missingNativeMethod();
  if (page.hasMore) {
    const cursor: string = page.cursor;
    void cursor;
  } else {
    // @ts-expect-error Exhausted metadata pages do not supply a continuation cursor.
    const cursor: string = page.cursor;
    void cursor;
  }
  // @ts-expect-error Metadata is not a body reader.
  page.items[0]?.stream();
  void [
    exact,
    readOnly,
    nativeMethodResult,
    deferred,
    service,
    wrapped,
    delegated,
    hybrid,
    legacyAnnotation,
    legacyOptions,
    unsafe,
  ];
}
