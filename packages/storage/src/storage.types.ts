import type { StorageError } from './storage.error';

// ---------------------------------------------------------------------------
// Body — all Web-standard, edge-safe (NO node Buffer / node streams).
// ---------------------------------------------------------------------------

export type Body =
  | Blob
  | File
  | ReadableStream<Uint8Array>
  | ArrayBuffer
  | ArrayBufferView
  | Uint8Array
  | string;

/** A multipart part must have a known length, so streams are excluded. */
export type PartBody = Blob | ArrayBuffer | ArrayBufferView | Uint8Array;

// ---------------------------------------------------------------------------
// Shared operation controls (retry / timeout / abort).
// ---------------------------------------------------------------------------

export interface RetryBackoffContext {
  /** 1-based retry number (attempt 1 is the first retry after the initial call). */
  attempt: number;
  error: StorageError;
}

export type RetryOptions = number | { max: number; backoff?: (ctx: RetryBackoffContext) => number };

export interface OperationOptions {
  /** Abort the operation when this signal fires. */
  signal?: AbortSignal;
  /** Per-attempt timeout in ms. `0` or negative disables timeout handling. */
  timeout?: number;
  /** Retry transient failures. A number is treated as `{ max: number }`. */
  retries?: RetryOptions;
}

// ---------------------------------------------------------------------------
// Upload.
// ---------------------------------------------------------------------------

export interface UploadProgress {
  /** Cumulative bytes sent so far. */
  loaded: number;
  /** Total bytes to send, when known (omitted for unknown-length streams). */
  total?: number;
}

/** Tuning for multipart uploads. `multipart: true` uses these defaults. */
export interface MultipartOptions {
  /** Bytes per part. Default 5 MiB (S3's minimum non-final part size). */
  partSize?: number;
  /** Parts uploaded concurrently. Default 4. */
  concurrency?: number;
}

export interface UploadOptions extends OperationOptions {
  contentType?: string;
  /** Persisted only when the driver advertises `supportsCacheControl`. */
  cacheControl?: string;
  /** Persisted only when the driver advertises `supportsMetadata` (empty == none). */
  metadata?: Record<string, string>;
  onProgress?: (p: UploadProgress) => void;
  /** Force/relax multipart. `true` uses {@link MultipartOptions} defaults. */
  multipart?: boolean | MultipartOptions;
}

export interface UploadResult {
  key: string;
  size: number;
  contentType: string;
  etag?: string;
  lastModified?: number;
  /** Reserved for the versioning middleware / provider versioning. */
  versionId?: string;
}

// ---------------------------------------------------------------------------
// Read / metadata.
// ---------------------------------------------------------------------------

/** 0-based, `end` inclusive (matches the HTTP `Range` header). */
export interface ByteRange {
  start: number;
  end?: number;
}

export interface DownloadOptions extends OperationOptions {
  /** Honored only when the driver advertises `supportsRange`. */
  range?: ByteRange;
}

export interface StoredFile {
  key: string;
  name: string;
  size: number;
  type: string;
  lastModified?: number;
  etag?: string;
  metadata?: Record<string, string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  blob(): Promise<Blob>;
  /** Web Streams only. */
  stream(): ReadableStream<Uint8Array>;
}

// ---------------------------------------------------------------------------
// List.
// ---------------------------------------------------------------------------

export interface ListOptions extends OperationOptions {
  prefix?: string;
  cursor?: string;
  limit?: number;
  /** S3-style folder folding. Honored only when the driver advertises `supportsDelimiter`. */
  delimiter?: string;
}

export interface ListResult {
  items: StoredFile[];
  /** Common prefixes when `delimiter` is set. */
  prefixes?: string[];
  /** Continuation cursor; absent when the listing is exhausted. */
  cursor?: string;
}

// ---------------------------------------------------------------------------
// Bulk delete (native primitive or facade fan-out).
// ---------------------------------------------------------------------------

export interface DeleteManyOptions extends OperationOptions {
  /** Concurrency for the fan-out fallback. Default 8. */
  concurrency?: number;
  /** Stop at the first error instead of collecting all. Default false. */
  stopOnError?: boolean;
}

export interface DeleteManyError {
  key: string;
  error: StorageError;
}

export interface DeleteManyResult {
  deleted: string[];
  errors?: DeleteManyError[];
}

// ---------------------------------------------------------------------------
// URLs / presign.
// ---------------------------------------------------------------------------

export interface UrlOptions extends OperationOptions {
  expiresIn?: number;
  /** Forces the signing path (e.g. to set `Content-Disposition: attachment`). */
  responseContentDisposition?: string;
}

export interface SignUploadOptions extends OperationOptions {
  expiresIn: number;
  contentType?: string;
  /** When set, drivers use a POST policy so the store enforces the size cap. */
  maxSize?: number;
  minSize?: number;
}

export type SignedUpload =
  | { method: 'PUT'; url: string; headers?: Record<string, string> }
  | { method: 'POST'; url: string; fields: Record<string, string> };

/** Advisory descriptor for what a driver's signing supports. */
export interface SignedUrlCapability {
  /** Can mint a presigned download URL via `url()`. */
  supported: boolean;
  /** Can mint a presigned upload via `signedUploadUrl()`. */
  upload: boolean;
  /** `url()` cryptographically binds a response `Content-Disposition` override. */
  responseContentDisposition?: boolean;
  /** Provider ceiling on `expiresIn` (seconds), if any. */
  maxExpiresIn?: number;
}

// ---------------------------------------------------------------------------
// Server-side multipart (buffered parts).
// ---------------------------------------------------------------------------

export interface CreateMultipartOptions extends OperationOptions {
  contentType?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size?: number;
}

export interface MultipartUpload {
  readonly key: string;
  readonly uploadId: string;
  uploadPart(partNumber: number, body: PartBody, opts?: OperationOptions): Promise<UploadedPart>;
  complete(parts: UploadedPart[], opts?: OperationOptions): Promise<UploadResult>;
  abort(opts?: OperationOptions): Promise<void>;
  /** Enables cross-request resume where the provider can list uploaded parts. */
  listParts?(opts?: OperationOptions): Promise<UploadedPart[]>;
}

// ---------------------------------------------------------------------------
// Browser-direct presigned multipart (distinct from server-side multipart —
// the browser holds no credentials, so it needs signed per-part PUT URLs).
// ---------------------------------------------------------------------------

export interface SignedMultipartCreate {
  uploadId: string;
  partSize: number;
}

export interface SignedPart {
  url: string;
  headers?: Record<string, string>;
}

export interface SignedMultipartCapability {
  create(
    key: string,
    opts: { contentType?: string; metadata?: Record<string, string>; partSize?: number },
  ): Promise<SignedMultipartCreate>;
  signPart(
    key: string,
    uploadId: string,
    partNumber: number,
    opts?: { expiresIn?: number },
  ): Promise<SignedPart>;
  complete(key: string, uploadId: string, parts: UploadedPart[]): Promise<UploadResult>;
  abort(key: string, uploadId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// The driver every backend implements.
// ---------------------------------------------------------------------------

export interface StorageDriver<Raw = unknown> {
  readonly name: string;
  readonly raw: Raw;

  // Capability flags — the facade gates on these BEFORE any driver call.
  // Unset is treated as `false`.
  readonly reportsUploadProgress?: boolean;
  readonly supportsRange?: boolean;
  readonly supportsDelimiter?: boolean;
  readonly supportsMetadata?: boolean;
  readonly supportsCacheControl?: boolean;
  readonly supportsServerSideCopy?: boolean;
  readonly signedUrl?: SignedUrlCapability;

  upload(key: string, body: Body, opts?: UploadOptions): Promise<UploadResult>;
  download(key: string, opts?: DownloadOptions): Promise<StoredFile>;
  head(key: string, opts?: OperationOptions): Promise<StoredFile>;
  exists(key: string, opts?: OperationOptions): Promise<boolean>;
  delete(key: string, opts?: OperationOptions): Promise<void>;
  /** Optional native bulk delete; the facade fans out to `delete` otherwise. */
  deleteMany?(keys: string[], opts?: DeleteManyOptions): Promise<DeleteManyResult>;
  copy(from: string, to: string, opts?: OperationOptions): Promise<void>;
  /** Optional native rename; the facade falls back to copy+delete otherwise. */
  move?(from: string, to: string, opts?: OperationOptions): Promise<void>;
  list(opts?: ListOptions): Promise<ListResult>;
  url(key: string, opts?: UrlOptions): Promise<string>;
  signedUploadUrl(key: string, opts: SignUploadOptions): Promise<SignedUpload>;

  /** Server-side multipart. Presence == capability. */
  createMultipartUpload?(key: string, opts?: CreateMultipartOptions): Promise<MultipartUpload>;
  resumeMultipartUpload?(key: string, uploadId: string): MultipartUpload;

  /** Browser-direct presigned multipart. Presence == capability. */
  signedMultipart?: SignedMultipartCapability;
}

/** Queryable capability snapshot for callers that branch up-front. */
export interface StorageCapabilities {
  rangeRead: boolean;
  uploadProgress: boolean;
  delimiter: boolean;
  metadata: boolean;
  cacheControl: boolean;
  serverSideCopy: boolean;
  multipart: boolean;
  signedMultipart: boolean;
  signedUrl: SignedUrlCapability;
}

// ---------------------------------------------------------------------------
// Facade options + observability hooks.
// ---------------------------------------------------------------------------

export interface StorageHookEvent {
  type: string;
  key?: string;
  status: 'success' | 'error';
  durationMs: number;
  error?: StorageError;
}

export interface StorageHooks {
  onOperation?: (e: StorageHookEvent) => void;
  onError?: (e: { type: string; key?: string; error: StorageError }) => void;
  onRetry?: (e: {
    type: string;
    key?: string;
    attempt: number;
    maxRetries: number;
    delayMs: number;
    error: StorageError;
  }) => void;
}

export interface StorageOptions extends OperationOptions {
  driver: StorageDriver;
  /** Sub-scopes the keyspace within a bucket; normalized (no leading/trailing '/'). */
  prefix?: string;
  /** Reject all mutating operations. */
  readonly?: boolean;
  hooks?: StorageHooks;
}
