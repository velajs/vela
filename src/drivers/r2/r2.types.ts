// Structural subset of the Cloudflare `R2Bucket` binding — only the members we
// call. Declaring it structurally (instead of importing @cloudflare/workers-types)
// keeps workers-types an optional peer; a real `R2Bucket` (and
// `@velajs/cloudflare`'s `R2Service.bucket`) is structurally assignable.

export type R2PutValue =
  | ReadableStream
  | ArrayBuffer
  | ArrayBufferView
  | string
  | Blob
  | null;

export interface R2HttpMetadataLike {
  contentType?: string;
  cacheControl?: string;
}

export interface R2PutOptionsLike {
  httpMetadata?: R2HttpMetadataLike;
  customMetadata?: Record<string, string>;
}

export interface R2GetOptionsLike {
  range?: { offset?: number; length?: number; suffix?: number };
}

export interface R2ListOptionsLike {
  prefix?: string;
  cursor?: string;
  limit?: number;
  delimiter?: string;
}

export interface R2ObjectLike {
  key: string;
  size: number;
  etag: string;
  uploaded: Date;
  httpMetadata?: R2HttpMetadataLike;
  customMetadata?: Record<string, string>;
}

export interface R2ObjectBodyLike extends R2ObjectLike {
  body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2ListResultLike {
  objects: R2ObjectLike[];
  truncated: boolean;
  cursor?: string;
  delimitedPrefixes: string[];
}

export interface R2UploadedPartLike {
  partNumber: number;
  etag: string;
}

export interface R2MultipartUploadLike {
  readonly uploadId: string;
  uploadPart(partNumber: number, value: R2PutValue): Promise<R2UploadedPartLike>;
  complete(parts: R2UploadedPartLike[]): Promise<R2ObjectLike>;
  abort(): Promise<void>;
}

export interface R2BucketLike {
  put(key: string, value: R2PutValue, options?: R2PutOptionsLike): Promise<R2ObjectLike | null>;
  get(key: string, options?: R2GetOptionsLike): Promise<R2ObjectBodyLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: R2ListOptionsLike): Promise<R2ListResultLike>;
  createMultipartUpload(key: string, options?: R2PutOptionsLike): Promise<R2MultipartUploadLike>;
  resumeMultipartUpload?(key: string, uploadId: string): R2MultipartUploadLike;
}

export interface R2DriverOptions {
  /** The Workers `R2Bucket` binding (e.g. `env.MY_BUCKET` or `R2Service.bucket`). */
  bucket: R2BucketLike;
  /** Public origin (r2.dev subdomain / custom domain) so `url()` can return a link. */
  publicBaseUrl?: string;
  /** Friendly driver name (defaults to `r2`). */
  name?: string;
}
