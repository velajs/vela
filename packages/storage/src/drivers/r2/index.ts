import { createStoredFile } from '../../internal/stored-file';
import { StorageError } from '../../storage.error';
import type {
  Body,
  CreateMultipartOptions,
  DownloadOptions,
  ListOptions,
  ListResult,
  MultipartUpload,
  OperationOptions,
  PartBody,
  StorageDriver,
  StoredFile,
  UploadOptions,
  UploadResult,
  UrlOptions,
} from '../../storage.types';
import type { R2BucketLike, R2DriverOptions, R2ObjectLike, R2PutValue } from './r2.types';

export type {
  R2BucketLike,
  R2DriverOptions,
  R2ObjectLike,
  R2ObjectBodyLike,
  R2MultipartUploadLike,
} from './r2.types';

function joinPublic(base: string, key: string): string {
  const enc = key.split('/').map(encodeURIComponent).join('/');
  return `${base.replace(/\/$/, '')}/${enc}`;
}

function metaOf(obj: R2ObjectLike) {
  return {
    key: obj.key,
    size: obj.size,
    type: obj.httpMetadata?.contentType ?? 'application/octet-stream',
    etag: obj.etag,
    lastModified: obj.uploaded instanceof Date ? obj.uploaded.getTime() : undefined,
    metadata: obj.customMetadata,
  };
}

/**
 * Cloudflare R2 driver — native binding mode only. Zero third-party deps
 * (no aws4fetch), fully edge-native I/O with no egress fees.
 *
 * It cannot presign (`signedUploadUrl` throws; `url()` needs `publicBaseUrl`).
 * For presigned URLs use `@velajs/storage/drivers/r2-http` (HTTP or hybrid mode).
 */
export function r2Driver(options: R2DriverOptions): StorageDriver<R2BucketLike> {
  const bucket = options.bucket;

  const mustGet = async (key: string) => {
    const obj = await bucket.get(key);
    if (!obj) throw new StorageError('NotFound', `not found: ${key}`);
    return obj;
  };

  return {
    name: options.name ?? 'r2',
    raw: bucket,
    supportsRange: true,
    supportsDelimiter: true,
    supportsMetadata: true,
    supportsCacheControl: true,
    supportsServerSideCopy: false,
    reportsUploadProgress: false,
    signedUrl: { supported: !!options.publicBaseUrl, upload: false },

    async upload(key: string, body: Body, opts?: UploadOptions): Promise<UploadResult> {
      const obj = await bucket.put(key, body as R2PutValue, {
        httpMetadata: { contentType: opts?.contentType, cacheControl: opts?.cacheControl },
        customMetadata: opts?.metadata,
      });
      if (!obj) throw new StorageError('Provider', `put failed: ${key}`);
      return {
        key,
        size: obj.size,
        contentType: opts?.contentType ?? 'application/octet-stream',
        etag: obj.etag,
        lastModified: obj.uploaded instanceof Date ? obj.uploaded.getTime() : undefined,
      };
    },

    async download(key: string, opts?: DownloadOptions): Promise<StoredFile> {
      const range = opts?.range
        ? {
            offset: opts.range.start,
            length: opts.range.end != null ? opts.range.end - opts.range.start + 1 : undefined,
          }
        : undefined;
      const obj = await bucket.get(key, range ? { range } : undefined);
      if (!obj) throw new StorageError('NotFound', `not found: ${key}`);
      const meta = metaOf(obj);
      const size = range ? (range.length ?? obj.size - range.offset) : obj.size;
      return createStoredFile({ ...meta, size }, { kind: 'stream', stream: obj.body });
    },

    async head(key: string): Promise<StoredFile> {
      const obj = await bucket.head(key);
      if (!obj) throw new StorageError('NotFound', `not found: ${key}`);
      return createStoredFile(metaOf(obj), {
        kind: 'lazy',
        fetch: async () => new Response((await mustGet(key)).body),
      });
    },

    async exists(key: string): Promise<boolean> {
      return (await bucket.head(key)) != null;
    },

    async delete(key: string): Promise<void> {
      await bucket.delete(key);
    },

    async deleteMany(keys: string[]) {
      await bucket.delete(keys);
      return { deleted: keys };
    },

    async copy(from: string, to: string): Promise<void> {
      const src = await bucket.get(from);
      if (!src) throw new StorageError('NotFound', `not found: ${from}`);
      await bucket.put(to, src.body, {
        httpMetadata: src.httpMetadata,
        customMetadata: src.customMetadata,
      });
    },

    async list(opts?: ListOptions): Promise<ListResult> {
      const res = await bucket.list({
        prefix: opts?.prefix,
        cursor: opts?.cursor,
        limit: opts?.limit,
        delimiter: opts?.delimiter,
      });
      return {
        items: res.objects.map((obj) =>
          createStoredFile(metaOf(obj), {
            kind: 'lazy',
            fetch: async () => new Response((await mustGet(obj.key)).body),
          }),
        ),
        prefixes: res.delimitedPrefixes.length ? res.delimitedPrefixes : undefined,
        cursor: res.truncated ? res.cursor : undefined,
      };
    },

    async url(key: string, _opts?: UrlOptions): Promise<string> {
      if (options.publicBaseUrl) return joinPublic(options.publicBaseUrl, key);
      throw new StorageError(
        'Unsupported',
        'r2 binding: url() needs publicBaseUrl (or use the r2-http/hybrid driver to presign)',
      );
    },

    async signedUploadUrl(): Promise<never> {
      throw new StorageError(
        'Unsupported',
        'r2 binding cannot presign uploads; use the r2-http or r2-hybrid driver',
      );
    },

    async createMultipartUpload(
      key: string,
      opts?: CreateMultipartOptions,
    ): Promise<MultipartUpload> {
      const mpu = await bucket.createMultipartUpload(key, {
        httpMetadata: { contentType: opts?.contentType, cacheControl: opts?.cacheControl },
        customMetadata: opts?.metadata,
      });
      return {
        key,
        uploadId: mpu.uploadId,
        async uploadPart(partNumber: number, part: PartBody, _o?: OperationOptions) {
          const up = await mpu.uploadPart(partNumber, part as R2PutValue);
          return { partNumber: up.partNumber, etag: up.etag };
        },
        async complete(parts) {
          const obj = await mpu.complete(
            parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
          );
          return {
            key,
            size: obj.size,
            contentType: opts?.contentType ?? 'application/octet-stream',
            etag: obj.etag,
          };
        },
        async abort() {
          await mpu.abort();
        },
      };
    },
  };
}
