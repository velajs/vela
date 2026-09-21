import { createStoredFile } from '../../internal/stored-file';
import { runWithRetry, throwIfAborted } from '../../internal/retry';
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
import type { R2BucketLike, R2DriverOptions, R2ObjectLike } from './r2.types';

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
export function r2Driver<Bucket extends R2BucketLike>(
  options: R2DriverOptions<Bucket>,
): StorageDriver<Bucket> {
  const bucket = options.bucket;
  // Native bindings do not accept AbortSignal. End the caller's wait, observe
  // late settlements, and never retry a write whose outcome is unknown.
  const native = <T>(
    work: (signal?: AbortSignal) => Promise<T>,
    opts?: OperationOptions,
    onDiscard?: (value: T) => void | Promise<void>,
  ) => runWithRetry(work, { signal: opts?.signal, timeout: opts?.timeout }, undefined, onDiscard);

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
      const obj = await native(
        () =>
          bucket.put(key, body, {
            httpMetadata: { contentType: opts?.contentType, cacheControl: opts?.cacheControl },
            customMetadata: opts?.metadata,
          }),
        opts,
      );
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
      if (
        opts?.range &&
        (!Number.isSafeInteger(opts.range.start) ||
          opts.range.start < 0 ||
          (opts.range.end !== undefined &&
            (!Number.isSafeInteger(opts.range.end) ||
              opts.range.end < opts.range.start ||
              !Number.isSafeInteger(opts.range.end - opts.range.start + 1))))
      )
        throw new StorageError(
          'InvalidRequest',
          'range must contain non-negative safe integers with end >= start',
        );
      const range = opts?.range
        ? {
            offset: opts.range.start,
            length: opts.range.end != null ? opts.range.end - opts.range.start + 1 : undefined,
          }
        : undefined;
      const obj = await native(
        () => bucket.get(key, range ? { range } : undefined),
        opts,
        (late) => late?.body.cancel(),
      );
      if (!obj) throw new StorageError('NotFound', `not found: ${key}`);
      const meta = metaOf(obj);
      const available = range ? Math.max(0, obj.size - range.offset) : obj.size;
      const size = range
        ? (obj.range?.length ?? Math.min(range.length ?? available, available))
        : obj.size;
      return createStoredFile({ ...meta, size }, { kind: 'stream', stream: obj.body });
    },

    async head(key: string, opts?: OperationOptions): Promise<StoredFile> {
      const obj = await native(() => bucket.head(key), opts);
      if (!obj) throw new StorageError('NotFound', `not found: ${key}`);
      return createStoredFile(metaOf(obj), {
        kind: 'lazy',
        fetch: async () => new Response((await mustGet(key)).body),
      });
    },

    async exists(key: string, opts?: OperationOptions): Promise<boolean> {
      return (await native(() => bucket.head(key), opts)) != null;
    },

    async delete(key: string, opts?: OperationOptions): Promise<void> {
      await native(() => bucket.delete(key), opts);
    },

    async deleteMany(keys: string[], opts?: OperationOptions) {
      await native(() => bucket.delete(keys), opts);
      return { deleted: keys };
    },

    async copy(from: string, to: string, opts?: OperationOptions): Promise<void> {
      await native(async (signal) => {
        const src = await bucket.get(from);
        if (!src) throw new StorageError('NotFound', `not found: ${from}`);
        try {
          throwIfAborted(signal);
          await bucket.put(to, src.body, {
            httpMetadata: src.httpMetadata,
            customMetadata: src.customMetadata,
          });
        } finally {
          // put owns the body until settlement; do not cancel it while in flight.
          if (!src.body.locked) await src.body.cancel().catch(() => {});
        }
      }, opts);
    },

    async list(opts?: ListOptions): Promise<ListResult> {
      const res = await native(
        () =>
          bucket.list({
            prefix: opts?.prefix,
            cursor: opts?.cursor,
            limit: opts?.limit,
            delimiter: opts?.delimiter,
            include: options.includeMetadata ? ['httpMetadata', 'customMetadata'] : undefined,
          }),
        opts,
      );
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
      const mpu = await native(
        () =>
          bucket.createMultipartUpload(key, {
            httpMetadata: { contentType: opts?.contentType, cacheControl: opts?.cacheControl },
            customMetadata: opts?.metadata,
          }),
        opts,
        (late) => late.abort(),
      );
      return {
        key,
        uploadId: mpu.uploadId,
        async uploadPart(partNumber: number, part: PartBody, o?: OperationOptions) {
          const up = await native(() => mpu.uploadPart(partNumber, part), o);
          return { partNumber: up.partNumber, etag: up.etag };
        },
        async complete(parts, o) {
          const obj = await native(
            () => mpu.complete(parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag }))),
            o,
          );
          return {
            key,
            size: obj.size,
            contentType: opts?.contentType ?? 'application/octet-stream',
            etag: obj.etag,
          };
        },
        async abort(o) {
          await native(() => mpu.abort(), o);
        },
      };
    },
  };
}
