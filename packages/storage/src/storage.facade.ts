import { byteLengthOf, chunkStream, countingStream, isStream, toStream } from './internal/body';
import { normalizeRetry, runWithRetry, throwIfAborted } from './internal/retry';
import { joinKey, normalizePrefix, sanitizeKey, stripPrefix } from './object-key';
import { StorageError } from './storage.error';
import type {
  Body,
  CreateMultipartOptions,
  DeleteManyError,
  DeleteManyOptions,
  DeleteManyResult,
  DownloadOptions,
  ListOptions,
  ListResult,
  MetadataListResult,
  MultipartOptions,
  MultipartUpload,
  OperationOptions,
  RetryOptions,
  SignedMultipartCapability,
  SignedUpload,
  SignUploadOptions,
  StorageCapabilities,
  StorageDriver,
  StorageOptions,
  StoredFile,
  StoredFileMetadata,
  UploadedPart,
  UploadOptions,
  UploadResult,
  UrlOptions,
} from './storage.types';

const DEFAULT_PART_SIZE = 5 * 1024 * 1024; // 5 MiB (S3 minimum non-final part)
const DEFAULT_CONCURRENCY = 4;
const MAX_MULTIPART_PARTS = 10_000;
const MAX_MULTIPART_CONCURRENCY = 32;
// Known-length bodies larger than this are routed through multipart so we never
// buffer a whole large object in memory (aws4fetch must hash the payload).
const MULTIPART_THRESHOLD = 16 * 1024 * 1024;

/**
 * The consumer-facing storage handle. Wraps a {@link StorageDriver} with
 * capability-gating (throws before any driver call), retry/timeout/abort,
 * prefix scoping, generic `move`/`deleteMany` fallbacks, multipart
 * orchestration, progress synthesis, and observability hooks.
 *
 * Framework-free — `StorageService` builds and caches one of these per bucket.
 */
export class Storage<Raw = unknown> {
  readonly #driver: StorageDriver<Raw>;
  readonly #prefix: string;
  readonly #readonly: boolean;
  readonly #opts: StorageOptions<Raw>;

  constructor(opts: StorageOptions<Raw>) {
    this.#opts = opts;
    this.#driver = opts.driver;
    this.#prefix = normalizePrefix(opts.prefix);
    this.#readonly = opts.readonly ?? false;
  }

  get raw(): Raw {
    return this.#driver.raw;
  }

  get driver(): StorageDriver<Raw> {
    return this.#driver;
  }

  get capabilities(): StorageCapabilities {
    const d = this.#driver;
    return {
      rangeRead: !!d.supportsRange,
      uploadProgress: !!d.reportsUploadProgress,
      delimiter: !!d.supportsDelimiter,
      metadata: !!d.supportsMetadata,
      cacheControl: !!d.supportsCacheControl,
      serverSideCopy: !!d.supportsServerSideCopy,
      multipart: typeof d.createMultipartUpload === 'function',
      signedMultipart: d.signedMultipart != null,
      signedUrl: d.signedUrl ?? { supported: false, upload: false },
    };
  }

  // ---- upload ------------------------------------------------------------

  async upload(key: string, body: Body, opts?: UploadOptions): Promise<UploadResult> {
    this.#assertWritable();
    this.#assertUploadSupported(opts);
    const d = this.#driver;
    const path = this.#path(key);
    const len = byteLengthOf(body);
    const wantsMultipart = opts?.multipart != null && opts.multipart !== false;
    const unknownStream = isStream(body) && len === undefined;
    const bigKnown = len != null && len > MULTIPART_THRESHOLD;
    const canMultipart = typeof d.createMultipartUpload === 'function';

    if (wantsMultipart && !canMultipart) {
      throw new StorageError('Unsupported', `${d.name}: multipart not supported`);
    }
    if ((wantsMultipart || unknownStream || bigKnown) && canMultipart) {
      const result = await this.#exec('upload', key, false, opts, (signal) =>
        this.#putMultipart(path, body, { ...opts, signal }),
      );
      return { ...result, key };
    }

    const streaming = isStream(body);
    let outBody = body;
    if (opts?.onProgress && !d.reportsUploadProgress && streaming) {
      outBody = countingStream(body, (loaded) => opts.onProgress!({ loaded, total: len }));
    }
    const result = await this.#exec('upload', key, !streaming, opts, (signal) =>
      d.upload(path, outBody, { ...opts, signal }),
    );
    if (opts?.onProgress && !d.reportsUploadProgress && !streaming && len != null) {
      opts.onProgress({ loaded: len, total: len });
    }
    return { ...result, key };
  }

  async #putMultipart(path: string, body: Body, opts?: UploadOptions): Promise<UploadResult> {
    const mp: MultipartOptions = typeof opts?.multipart === 'object' ? opts.multipart : {};
    const partSize = mp.partSize ?? DEFAULT_PART_SIZE;
    if (!Number.isSafeInteger(partSize) || partSize <= 0) {
      throw new StorageError('InvalidRequest', 'multipart partSize must be a positive integer');
    }
    const requestedConcurrency = mp.concurrency ?? DEFAULT_CONCURRENCY;
    if (!Number.isSafeInteger(requestedConcurrency) || requestedConcurrency <= 0) {
      throw new StorageError('InvalidRequest', 'multipart concurrency must be a positive integer');
    }
    const concurrency = Math.min(requestedConcurrency, MAX_MULTIPART_CONCURRENCY);
    const total = byteLengthOf(body);
    const upload = await runWithRetry(
      (signal) =>
        this.#driver.createMultipartUpload!(path, {
          contentType: opts?.contentType,
          cacheControl: opts?.cacheControl,
          metadata: opts?.metadata,
          signal,
        }),
      { signal: opts?.signal },
      undefined,
      (late) => late.abort(),
    );

    const inflight = new Set<Promise<void>>();
    try {
      const parts: UploadedPart[] = [];
      let uploadedBytes = 0;
      let partNumber = 0;
      let failure: { error: unknown } | undefined;
      const assertPartsSucceeded = () => {
        if (failure) throw failure.error;
      };

      for await (const chunk of chunkStream(toStream(body), partSize, opts?.signal)) {
        throwIfAborted(opts?.signal);
        assertPartsSucceeded();
        partNumber += 1;
        if (partNumber > MAX_MULTIPART_PARTS) {
          throw new StorageError('InvalidRequest', 'multipart upload exceeds 10,000 parts');
        }
        const n = partNumber;
        const size = chunk.byteLength;
        const task: Promise<void> = (async () => {
          const up = await runWithRetry((signal) => upload.uploadPart(n, chunk, { signal }), {
            signal: opts?.signal,
          });
          parts[n - 1] = { partNumber: n, etag: up.etag, size: up.size ?? size };
          uploadedBytes += size;
          opts?.onProgress?.({ loaded: uploadedBytes, total });
        })();
        const tracked = task
          .catch((error: unknown) => {
            failure ??= { error };
          })
          .finally(() => inflight.delete(tracked));
        inflight.add(tracked);
        if (inflight.size >= concurrency) {
          await Promise.race(inflight);
          assertPartsSucceeded();
        }
      }
      await Promise.all(inflight);
      assertPartsSucceeded();
      throwIfAborted(opts?.signal);
      return await upload.complete(parts, { signal: opts?.signal });
    } catch (e) {
      await Promise.all(inflight);
      await upload.abort().catch(() => {});
      throw StorageError.wrap(e);
    }
  }

  // ---- read / metadata ---------------------------------------------------

  async download(key: string, opts?: DownloadOptions): Promise<StoredFile> {
    if (opts?.range) this.#assertRange();
    const file = await this.#exec(
      'download',
      key,
      true,
      opts,
      (signal) => this.#driver.download(this.#path(key), { ...opts, signal }),
      (late) => late.stream().cancel(),
    );
    return this.#relabel(file, key);
  }

  async head(key: string, opts?: OperationOptions): Promise<StoredFile> {
    const file = await this.#exec('head', key, true, opts, (signal) =>
      this.#driver.head(this.#path(key), { ...opts, signal }),
    );
    return this.#relabel(file, key);
  }

  /** Metadata snapshot without lazy body readers. Use download() for controlled I/O. */
  async stat(key: string, opts?: OperationOptions): Promise<StoredFileMetadata> {
    return metadataOf(await this.head(key, opts));
  }

  exists(key: string, opts?: OperationOptions): Promise<boolean> {
    return this.#exec('exists', key, true, opts, (signal) =>
      this.#driver.exists(this.#path(key), { ...opts, signal }),
    );
  }

  // ---- mutations ---------------------------------------------------------

  delete(key: string, opts?: OperationOptions): Promise<void>;
  delete(keys: string[], opts?: DeleteManyOptions): Promise<DeleteManyResult>;
  async delete(
    keyOrKeys: string | string[],
    opts?: OperationOptions | DeleteManyOptions,
  ): Promise<void | DeleteManyResult> {
    this.#assertWritable();
    if (Array.isArray(keyOrKeys)) return this.#deleteMany(keyOrKeys, opts as DeleteManyOptions);
    const key = keyOrKeys;
    return this.#exec('delete', key, true, opts, (signal) =>
      this.#driver.delete(this.#path(key), { ...opts, signal }),
    );
  }

  async #deleteMany(keys: string[], opts?: DeleteManyOptions): Promise<DeleteManyResult> {
    const d = this.#driver;
    if (d.deleteMany) {
      const res = await this.#exec('deleteMany', undefined, true, opts, (signal) =>
        d.deleteMany!(
          keys.map((k) => this.#path(k)),
          { ...opts, signal },
        ),
      );
      return {
        deleted: res.deleted.map((k) => this.#strip(k)),
        errors: res.errors?.map((e) => ({ key: this.#strip(e.key), error: e.error })),
      };
    }
    return this.#exec('deleteMany', undefined, false, opts, async (signal) => {
      // Generic bounded fan-out fallback.
      const concurrency = Math.max(1, opts?.concurrency ?? 8);
      const stopOnError = opts?.stopOnError ?? false;
      const deleted: string[] = [];
      const errors: DeleteManyError[] = [];
      let index = 0;
      let stopped = false;
      const worker = async () => {
        while (index < keys.length && !stopped) {
          if (signal?.aborted) break;
          const key = keys[index++];
          try {
            await d.delete(this.#path(key!), { signal });
            deleted.push(key!);
          } catch (e) {
            const error = StorageError.wrap(e);
            errors.push({ key: key!, error });
            if (stopOnError) {
              stopped = true;
              throw error;
            }
          }
        }
      };
      const runners = Array.from({ length: Math.min(concurrency, keys.length) }, worker);
      if (stopOnError) await Promise.all(runners);
      else await Promise.allSettled(runners);
      throwIfAborted(signal);
      return { deleted, errors: errors.length ? errors : undefined };
    });
  }

  async copy(from: string, to: string, opts?: OperationOptions): Promise<void> {
    this.#assertWritable();
    return this.#exec('copy', to, true, opts, (signal) =>
      this.#driver.copy(this.#path(from), this.#path(to), { ...opts, signal }),
    );
  }

  async move(from: string, to: string, opts?: OperationOptions): Promise<void> {
    this.#assertWritable();
    const f = this.#path(from);
    const t = this.#path(to);
    if (f === t) return;
    if (this.#driver.move) {
      await this.#exec('move', to, true, opts, (signal) =>
        this.#driver.move!(f, t, { ...opts, signal }),
      );
      return;
    }
    await this.#exec('move', to, true, opts, async (signal) => {
      await this.#driver.copy(f, t, { ...opts, signal });
      throwIfAborted(signal);
      await this.#driver.delete(f, { ...opts, signal });
    });
  }

  // ---- list --------------------------------------------------------------

  async list(opts?: ListOptions): Promise<ListResult> {
    if (opts?.delimiter) this.#assertDelimiter();
    const scopedPrefix = this.#listPrefix(opts?.prefix);
    const res = await this.#exec('list', undefined, true, opts, (signal) =>
      this.#driver.list({ ...opts, prefix: scopedPrefix, signal }),
    );
    return {
      items: res.items.map((f) => this.#relabel(f, this.#strip(f.key))),
      prefixes: res.prefixes?.map((p) => this.#strip(p)),
      cursor: res.cursor,
    };
  }

  /** Project listing metadata without accessing any body or doing extra HEADs. */
  async listMetadata(opts?: ListOptions): Promise<MetadataListResult> {
    const page = await this.list(opts);
    const metadata = { items: page.items.map(metadataOf), prefixes: page.prefixes };
    return page.cursor === undefined
      ? { ...metadata, hasMore: false }
      : { ...metadata, hasMore: true, cursor: page.cursor };
  }

  async *listAll(opts?: ListOptions): AsyncGenerator<StoredFile> {
    let cursor = opts?.cursor;
    do {
      const page = await this.list({ ...opts, cursor });
      for (const item of page.items) yield item;
      cursor = page.cursor;
    } while (cursor);
  }

  // ---- URLs / presign ----------------------------------------------------

  async url(key: string, opts?: UrlOptions): Promise<string> {
    if (!this.#driver.signedUrl?.supported) {
      throw new StorageError('Unsupported', `${this.#driver.name}: url() not supported`);
    }
    return this.#exec('url', key, true, opts, (signal) =>
      this.#driver.url(this.#path(key), { ...opts, signal }),
    );
  }

  async signedUploadUrl(key: string, opts: SignUploadOptions): Promise<SignedUpload> {
    this.#assertWritable();
    if (!this.#driver.signedUrl?.upload) {
      throw new StorageError('Unsupported', `${this.#driver.name}: signed uploads not supported`);
    }
    return this.#exec('signedUploadUrl', key, true, opts, (signal) =>
      this.#driver.signedUploadUrl(this.#path(key), { ...opts, signal }),
    );
  }

  /** Prefix-bound view of the driver's presigned-multipart capability. */
  get signedMultipart(): SignedMultipartCapability | undefined {
    const cap = this.#driver.signedMultipart;
    if (!cap) return undefined;
    const path = (k: string) => this.#path(k);
    return {
      create: (key, o) => cap.create(path(key), o),
      signPart: (key, uploadId, partNumber, o) => cap.signPart(path(key), uploadId, partNumber, o),
      complete: (key, uploadId, parts) => cap.complete(path(key), uploadId, parts),
      abort: (key, uploadId) => cap.abort(path(key), uploadId),
    };
  }

  // ---- low-level multipart ----------------------------------------------

  async createMultipartUpload(
    key: string,
    opts?: CreateMultipartOptions,
  ): Promise<MultipartUpload> {
    this.#assertWritable();
    if (typeof this.#driver.createMultipartUpload !== 'function') {
      throw new StorageError('Unsupported', `${this.#driver.name}: multipart not supported`);
    }
    const upload = await this.#exec(
      'createMultipartUpload',
      key,
      false,
      opts,
      (signal) => this.#driver.createMultipartUpload!(this.#path(key), { ...opts, signal }),
      (late) => late.abort(),
    );
    return this.#multipart(upload);
  }

  resumeMultipartUpload(key: string, uploadId: string): MultipartUpload {
    this.#assertWritable();
    if (typeof this.#driver.resumeMultipartUpload !== 'function') {
      throw new StorageError('Unsupported', `${this.#driver.name}: multipart resume not supported`);
    }
    return this.#multipart(this.#driver.resumeMultipartUpload(this.#path(key), uploadId));
  }

  #multipart(upload: MultipartUpload): MultipartUpload {
    const wrapped: MultipartUpload = {
      key: upload.key,
      uploadId: upload.uploadId,
      uploadPart: (partNumber, body, opts) =>
        this.#exec('uploadPart', upload.key, true, opts, (signal) =>
          upload.uploadPart(partNumber, body, { ...opts, signal }),
        ),
      complete: (parts, opts) =>
        this.#exec('completeMultipartUpload', upload.key, false, opts, (signal) =>
          upload.complete(parts, { ...opts, signal }),
        ),
      abort: (opts) =>
        this.#exec('abortMultipartUpload', upload.key, true, opts, (signal) =>
          upload.abort({ ...opts, signal }),
        ),
    };
    if (upload.listParts)
      wrapped.listParts = (opts) =>
        this.#exec('listParts', upload.key, true, opts, (signal) =>
          upload.listParts!({ ...opts, signal }),
        );
    return wrapped;
  }

  // ---- ergonomics --------------------------------------------------------

  /** A key-bound handle over the common single-object operations. */
  file(key: string): FileHandle {
    return {
      key,
      upload: (body, o) => this.upload(key, body, o),
      download: (o) => this.download(key, o),
      head: (o) => this.head(key, o),
      exists: (o) => this.exists(key, o),
      delete: (o) => this.delete(key, o),
      url: (o) => this.url(key, o),
      signedUploadUrl: (o) => this.signedUploadUrl(key, o),
    };
  }

  /** A read-only clone of this handle (mutations throw `ReadOnly`). */
  readonly(): Storage<Raw> {
    return new Storage({ ...this.#opts, readonly: true });
  }

  // ---- internals ---------------------------------------------------------

  #path(key: string): string {
    return joinKey(this.#prefix, sanitizeKey(key));
  }

  #strip(storedKey: string): string {
    return stripPrefix(this.#prefix, storedKey);
  }

  #listPrefix(prefix: string | undefined): string | undefined {
    if (!this.#prefix) return prefix;
    return prefix ? `${this.#prefix}/${prefix}` : `${this.#prefix}/`;
  }

  #relabel(file: StoredFile, logicalKey: string): StoredFile {
    if (file.key === logicalKey) return file;
    const name = logicalKey.slice(logicalKey.lastIndexOf('/') + 1);
    return {
      key: logicalKey,
      name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
      etag: file.etag,
      metadata: file.metadata,
      arrayBuffer: () => file.arrayBuffer(),
      text: () => file.text(),
      blob: () => file.blob(),
      stream: () => file.stream(),
    };
  }

  #assertWritable(): void {
    if (this.#readonly) throw new StorageError('ReadOnly', 'storage handle is read-only');
  }

  #assertUploadSupported(opts?: UploadOptions): void {
    const d = this.#driver;
    if (opts?.metadata && Object.keys(opts.metadata).length > 0 && !d.supportsMetadata) {
      throw new StorageError('Unsupported', `${d.name}: metadata not supported`);
    }
    if (opts?.cacheControl && !d.supportsCacheControl) {
      throw new StorageError('Unsupported', `${d.name}: cacheControl not supported`);
    }
  }

  #assertRange(): void {
    if (!this.#driver.supportsRange) {
      throw new StorageError('Unsupported', `${this.#driver.name}: range reads not supported`);
    }
  }

  #assertDelimiter(): void {
    if (!this.#driver.supportsDelimiter) {
      throw new StorageError('Unsupported', `${this.#driver.name}: delimiter not supported`);
    }
  }

  async #exec<T>(
    type: string,
    key: string | undefined,
    replayable: boolean,
    opts: OperationOptions | undefined,
    fn: (signal: AbortSignal | undefined) => Promise<T>,
    onDiscard?: (value: T) => void | Promise<void>,
  ): Promise<T> {
    const started = Date.now();
    const retries: RetryOptions | undefined = replayable
      ? (opts?.retries ?? this.#opts.retries)
      : 0;
    const maxRetries = normalizeRetry(retries).max;
    const hooks = this.#opts.hooks;
    try {
      const result = await runWithRetry(
        fn,
        {
          retries,
          timeout: opts?.timeout ?? this.#opts.timeout,
          signal: opts?.signal ?? this.#opts.signal,
        },
        (info) =>
          hooks?.onRetry?.({
            type,
            key,
            attempt: info.attempt,
            maxRetries,
            delayMs: info.delayMs,
            error: info.error,
          }),
        onDiscard,
      );
      hooks?.onOperation?.({ type, key, status: 'success', durationMs: Date.now() - started });
      return result;
    } catch (e) {
      const error = StorageError.wrap(e);
      hooks?.onError?.({ type, key, error });
      hooks?.onOperation?.({
        type,
        key,
        status: 'error',
        durationMs: Date.now() - started,
        error,
      });
      throw error;
    }
  }
}

export interface FileHandle {
  readonly key: string;
  upload(body: Body, opts?: UploadOptions): Promise<UploadResult>;
  download(opts?: DownloadOptions): Promise<StoredFile>;
  head(opts?: OperationOptions): Promise<StoredFile>;
  exists(opts?: OperationOptions): Promise<boolean>;
  delete(opts?: OperationOptions): Promise<void>;
  url(opts?: UrlOptions): Promise<string>;
  signedUploadUrl(opts: SignUploadOptions): Promise<SignedUpload>;
}

export function createStorage<Raw = unknown>(opts: StorageOptions<Raw>): Storage<Raw> {
  return new Storage(opts);
}

function metadataOf(file: StoredFile): StoredFileMetadata {
  return {
    key: file.key,
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
    etag: file.etag,
    metadata: file.metadata ? { ...file.metadata } : undefined,
  };
}
