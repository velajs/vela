import { Injectable } from '@velajs/vela';
import { createStorage, Storage } from './storage.facade';
import type {
  Body,
  DeleteManyOptions,
  DeleteManyResult,
  DownloadOptions,
  ListOptions,
  ListResult,
  MetadataListResult,
  OperationOptions,
  SignedUpload,
  SignUploadOptions,
  StorageDriver,
  StorageHooks,
  StoredFile,
  StoredFileMetadata,
  UploadOptions,
  UploadResult,
  UrlOptions,
} from './storage.types';

/**
 * Build the real driver on first property access and delegate to it. This is
 * the edge-binding-safe seam: the driver factory (which may read Cloudflare
 * bindings / `c.env` secrets) does not run at module load — only on the first
 * storage operation, which happens at request time.
 *
 * Functions are bound to the built driver so class-based drivers keep `this`.
 */
export function lazyDriver<Raw = unknown>(build: () => StorageDriver<Raw>): StorageDriver<Raw> {
  let built: StorageDriver<Raw> | undefined;
  const ensure = (): StorageDriver<Raw> => (built ??= build());
  return new Proxy({} as StorageDriver<Raw>, {
    get(_target, prop) {
      const driver = ensure() as unknown as Record<string | symbol, unknown>;
      const value = driver[prop];
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(driver)
        : value;
    },
    has(_target, prop) {
      return prop in (ensure() as unknown as object);
    },
  });
}

export interface StorageServiceOptions {
  name: string;
  prefix?: string;
  readonly?: boolean;
  hooks?: StorageHooks;
}

/**
 * The injectable consumers reach for. Wraps one bucket's {@link Storage}
 * facade (lazy driver construction), plus thin forwarders for the common
 * single-object operations so `service.upload(...)` works without reaching
 * through `.storage`.
 *
 * For multiple buckets, register `StorageModule.forRoot({ name })` per bucket
 * and inject with `@InjectStorage(name)`.
 */
@Injectable()
export class StorageService<Raw = unknown> {
  readonly storage: Storage<Raw>;
  readonly name: string;

  constructor(build: () => StorageDriver<Raw>, options: StorageServiceOptions) {
    this.name = options.name;
    this.storage = createStorage({
      driver: lazyDriver(build),
      prefix: options.prefix,
      readonly: options.readonly,
      hooks: options.hooks,
    });
  }

  upload(key: string, body: Body, opts?: UploadOptions): Promise<UploadResult> {
    return this.storage.upload(key, body, opts);
  }
  download(key: string, opts?: DownloadOptions): Promise<StoredFile> {
    return this.storage.download(key, opts);
  }
  head(key: string, opts?: OperationOptions): Promise<StoredFile> {
    return this.storage.head(key, opts);
  }
  stat(key: string, opts?: OperationOptions): Promise<StoredFileMetadata> {
    return this.storage.stat(key, opts);
  }
  exists(key: string, opts?: OperationOptions): Promise<boolean> {
    return this.storage.exists(key, opts);
  }
  delete(key: string, opts?: OperationOptions): Promise<void> {
    return this.storage.delete(key, opts);
  }
  deleteMany(keys: string[], opts?: DeleteManyOptions): Promise<DeleteManyResult> {
    return this.storage.delete(keys, opts);
  }
  copy(from: string, to: string, opts?: OperationOptions): Promise<void> {
    return this.storage.copy(from, to, opts);
  }
  move(from: string, to: string, opts?: OperationOptions): Promise<void> {
    return this.storage.move(from, to, opts);
  }
  list(opts?: ListOptions): Promise<ListResult> {
    return this.storage.list(opts);
  }
  listMetadata(opts?: ListOptions): Promise<MetadataListResult> {
    return this.storage.listMetadata(opts);
  }
  url(key: string, opts?: UrlOptions): Promise<string> {
    return this.storage.url(key, opts);
  }
  signedUploadUrl(key: string, opts: SignUploadOptions): Promise<SignedUpload> {
    return this.storage.signedUploadUrl(key, opts);
  }
}
