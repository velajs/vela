import { byteLengthOf } from '../internal/body';
import { createStoredFile } from '../internal/stored-file';
import { StorageError } from '../storage.error';
import type {
  Body,
  DownloadOptions,
  ListOptions,
  ListResult,
  OperationOptions,
  SignUploadOptions,
  StorageDriver,
  StoredFile,
  UploadOptions,
  UploadResult,
  UrlOptions,
} from '../storage.types';

// Opt-in bridge for `@storagesdk/adapters`. It is defined against a STRUCTURAL
// interface (below) — never an import of `@storagesdk/core` — so this file
// stays edge-clean and adds no dependency. Bring your own storagesdk adapter;
// it is structurally assignable. NOTE: whichever storagesdk adapter you
// construct may pull the AWS SDK / node built-ins, so this subpath is for
// Node/Bun deployments, never the edge path. It is never re-exported from `.`.

/** Metadata for one storagesdk object (path-based). */
export interface StorageSdkItemMeta {
  path: string;
  size: number;
  contentType: string;
  etag: string;
  lastModified: Date | number;
  metadata?: Record<string, string>;
}

/** A storagesdk download result: metadata plus the buffered body. */
export interface StorageSdkItem extends StorageSdkItemMeta {
  body: Uint8Array<ArrayBuffer>;
}

export interface StorageSdkListResult {
  items: StorageSdkItemMeta[];
  cursor?: string;
  prefixes?: string[];
}

/** The structural subset of a `@storagesdk/adapters` adapter we consume. */
export interface StorageSdkAdapterLike<Raw = unknown> {
  readonly name?: string;
  readonly raw?: Raw;
  download(path: string, opts?: { signal?: AbortSignal }): Promise<StorageSdkItem>;
  head(path: string, opts?: { signal?: AbortSignal }): Promise<StorageSdkItemMeta>;
  list(opts?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
    delimiter?: string;
    signal?: AbortSignal;
  }): Promise<StorageSdkListResult>;
  url(path: string, opts?: { expiresIn?: number; signal?: AbortSignal }): Promise<string>;
  upload(
    path: string,
    body: Body,
    opts?: { contentType?: string; metadata?: Record<string, string>; signal?: AbortSignal },
  ): Promise<StorageSdkItemMeta | void>;
  delete(path: string, opts?: { signal?: AbortSignal }): Promise<void>;
  copy(from: string, to: string, opts?: { signal?: AbortSignal }): Promise<void>;
  move?(from: string, to: string, opts?: { signal?: AbortSignal }): Promise<void>;
  exists?(path: string, opts?: { signal?: AbortSignal }): Promise<boolean>;
  signedUploadUrl?(
    path: string,
    opts: { expiresIn: number; contentType?: string },
  ): Promise<{ method: 'PUT'; url: string; headers?: Record<string, string> }>;
}

export interface StorageSdkBridgeOptions {
  /** Advertise range support (only if your adapter honors `range`). Default false. */
  supportsRange?: boolean;
  /** Advertise delimiter/prefix support. Default false. */
  supportsDelimiter?: boolean;
  /** Advertise arbitrary metadata support. Default true. */
  supportsMetadata?: boolean;
  /** Advertise cache-control support. Default false. */
  supportsCacheControl?: boolean;
}

function toMillis(d: Date | number | undefined): number | undefined {
  if (d == null) return undefined;
  return d instanceof Date ? d.getTime() : d;
}

function metaOf(item: StorageSdkItemMeta) {
  return {
    key: item.path,
    size: item.size,
    type: item.contentType || 'application/octet-stream',
    etag: item.etag,
    lastModified: toMillis(item.lastModified),
    metadata: item.metadata,
  };
}

/**
 * Adapt a `@storagesdk/adapters` adapter to a {@link StorageDriver}.
 *
 * storagesdk's shape differs from ours (path-based; `download` returns buffered
 * bytes rather than a stream; no first-class multipart or capability flags),
 * so this is an explicit mapping. Multipart / presigned-multipart are not
 * exposed (the facade will gate them as `Unsupported`).
 */
export function storageSdkDriver<Raw = unknown>(
  adapter: StorageSdkAdapterLike<Raw>,
  options?: StorageSdkBridgeOptions,
): StorageDriver<Raw> {
  const hasUploadUrl = typeof adapter.signedUploadUrl === 'function';

  const driver: StorageDriver<Raw> = {
    name: `storagesdk:${adapter.name ?? 'adapter'}`,
    raw: adapter.raw as Raw,
    supportsRange: options?.supportsRange ?? false,
    supportsDelimiter: options?.supportsDelimiter ?? false,
    supportsMetadata: options?.supportsMetadata ?? true,
    supportsCacheControl: options?.supportsCacheControl ?? false,
    supportsServerSideCopy: true,
    reportsUploadProgress: false,
    signedUrl: { supported: typeof adapter.url === 'function', upload: hasUploadUrl },

    async upload(key: string, body: Body, opts?: UploadOptions): Promise<UploadResult> {
      const r = await adapter.upload(key, body, {
        contentType: opts?.contentType,
        metadata: opts?.metadata,
        signal: opts?.signal,
      });
      return {
        key,
        size: r?.size ?? byteLengthOf(body) ?? 0,
        contentType: opts?.contentType ?? r?.contentType ?? 'application/octet-stream',
        etag: r?.etag,
        lastModified: toMillis(r?.lastModified),
      };
    },

    async download(key: string, opts?: DownloadOptions): Promise<StoredFile> {
      const item = await adapter.download(key, { signal: opts?.signal });
      return createStoredFile(metaOf(item), { kind: 'bytes', bytes: item.body });
    },

    async head(key: string, opts?: OperationOptions): Promise<StoredFile> {
      const item = await adapter.head(key, { signal: opts?.signal });
      return createStoredFile(metaOf(item), {
        kind: 'lazy',
        fetch: async () => new Response((await adapter.download(key)).body),
      });
    },

    async exists(key: string, opts?: OperationOptions): Promise<boolean> {
      if (adapter.exists) return adapter.exists(key, { signal: opts?.signal });
      try {
        await adapter.head(key, { signal: opts?.signal });
        return true;
      } catch (e) {
        if (e instanceof StorageError && e.code === 'NotFound') return false;
        if (e && typeof e === 'object' && (e as { code?: string }).code === 'NotFound') return false;
        throw e;
      }
    },

    async delete(key: string, opts?: OperationOptions): Promise<void> {
      await adapter.delete(key, { signal: opts?.signal });
    },

    async copy(from: string, to: string, opts?: OperationOptions): Promise<void> {
      await adapter.copy(from, to, { signal: opts?.signal });
    },

    async list(opts?: ListOptions): Promise<ListResult> {
      const r = await adapter.list({
        prefix: opts?.prefix,
        cursor: opts?.cursor,
        limit: opts?.limit,
        delimiter: opts?.delimiter,
        signal: opts?.signal,
      });
      return {
        items: r.items.map((item) =>
          createStoredFile(metaOf(item), {
            kind: 'lazy',
            fetch: async () => new Response((await adapter.download(item.path)).body),
          }),
        ),
        prefixes: r.prefixes,
        cursor: r.cursor,
      };
    },

    async url(key: string, opts?: UrlOptions): Promise<string> {
      return adapter.url(key, { expiresIn: opts?.expiresIn, signal: opts?.signal });
    },

    async signedUploadUrl(key: string, opts: SignUploadOptions) {
      if (!adapter.signedUploadUrl) {
        throw new StorageError('Unsupported', 'storagesdk adapter cannot presign uploads');
      }
      return adapter.signedUploadUrl(key, { expiresIn: opts.expiresIn, contentType: opts.contentType });
    },
  };

  if (adapter.move) {
    driver.move = (from, to, opts) => adapter.move!(from, to, { signal: opts?.signal });
  }
  return driver;
}
