import type { StorageDriver } from '../storage.types';

/** A driver middleware: wraps a driver, returns a driver. */
export type Middleware = (inner: StorageDriver) => StorageDriver;

/** Built-in wrappers keep the primary native handle intact. */
export type RawPreservingMiddleware = <Raw>(inner: StorageDriver<Raw>) => StorageDriver<Raw>;

/**
 * Build a driver that delegates to `inner`, applying `over` overrides and
 * omitting the methods in `omit`. Explicit delegation (not spread) keeps
 * class-based drivers' `this`. Optional methods are forwarded only when the
 * inner driver has them (so `presence == capability` is preserved), unless
 * omitted (e.g. a body-transforming middleware suppresses multipart/presign).
 */
export function passthrough<Raw = unknown>(
  inner: StorageDriver<Raw>,
  over: Partial<StorageDriver> = {},
  omit: ReadonlyArray<keyof StorageDriver> = [],
): StorageDriver<Raw> {
  const omitted = new Set<keyof StorageDriver>(omit);
  const has = (k: keyof StorageDriver) => !omitted.has(k);

  const d: StorageDriver<Raw> = {
    name: over.name ?? inner.name,
    raw: inner.raw,
    reportsUploadProgress: over.reportsUploadProgress ?? inner.reportsUploadProgress,
    supportsRange: over.supportsRange ?? inner.supportsRange,
    supportsDelimiter: over.supportsDelimiter ?? inner.supportsDelimiter,
    supportsMetadata: over.supportsMetadata ?? inner.supportsMetadata,
    supportsCacheControl: over.supportsCacheControl ?? inner.supportsCacheControl,
    supportsServerSideCopy: over.supportsServerSideCopy ?? inner.supportsServerSideCopy,
    signedUrl: over.signedUrl ?? inner.signedUrl,
    upload: over.upload ?? ((k, b, o) => inner.upload(k, b, o)),
    download: over.download ?? ((k, o) => inner.download(k, o)),
    head: over.head ?? ((k, o) => inner.head(k, o)),
    exists: over.exists ?? ((k, o) => inner.exists(k, o)),
    delete: over.delete ?? ((k, o) => inner.delete(k, o)),
    copy: over.copy ?? ((f, t, o) => inner.copy(f, t, o)),
    list: over.list ?? ((o) => inner.list(o)),
    url: over.url ?? ((k, o) => inner.url(k, o)),
    signedUploadUrl: over.signedUploadUrl ?? ((k, o) => inner.signedUploadUrl(k, o)),
  };

  if (has('deleteMany') && (over.deleteMany || inner.deleteMany)) {
    d.deleteMany = over.deleteMany ?? ((ks, o) => inner.deleteMany!(ks, o));
  }
  if (has('move') && (over.move || inner.move)) {
    d.move = over.move ?? ((f, t, o) => inner.move!(f, t, o));
  }
  if (has('createMultipartUpload') && (over.createMultipartUpload || inner.createMultipartUpload)) {
    d.createMultipartUpload =
      over.createMultipartUpload ?? ((k, o) => inner.createMultipartUpload!(k, o));
  }
  if (has('resumeMultipartUpload') && (over.resumeMultipartUpload || inner.resumeMultipartUpload)) {
    d.resumeMultipartUpload =
      over.resumeMultipartUpload ?? ((k, u) => inner.resumeMultipartUpload!(k, u));
  }
  if (has('signedMultipart') && (over.signedMultipart || inner.signedMultipart)) {
    d.signedMultipart = over.signedMultipart ?? inner.signedMultipart;
  }
  return d;
}
