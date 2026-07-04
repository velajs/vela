import type { StorageDriver } from '../../storage.types';
import { r2Driver } from '../r2';
import type { R2BucketLike } from '../r2/r2.types';
import { s3Driver } from '../s3';

export interface R2HttpOptions {
  /** Cloudflare account ID — the default endpoint is derived from it. */
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Override the endpoint (jurisdiction-specific R2 URLs). */
  endpoint?: string;
  region?: string;
  publicBaseUrl?: string;
  defaultUrlExpiresIn?: number;
  fetch?: typeof fetch;
}

function endpointFor(o: R2HttpOptions): string {
  return o.endpoint ?? `https://${o.accountId}.r2.cloudflarestorage.com`;
}

/**
 * R2 over the S3-compatible HTTP API (aws4fetch). All I/O goes over HTTP and
 * presigning works. Prefer the native binding driver (`../r2`) for I/O when
 * running inside a Worker; use this from Node/other runtimes, or use
 * {@link r2HybridDriver} to combine binding I/O with HTTP presigning.
 */
export function r2HttpDriver(o: R2HttpOptions): StorageDriver {
  return s3Driver({
    endpoint: endpointFor(o),
    region: o.region ?? 'auto',
    bucket: o.bucket,
    forcePathStyle: true,
    credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey },
    publicBaseUrl: o.publicBaseUrl,
    defaultUrlExpiresIn: o.defaultUrlExpiresIn,
    fetch: o.fetch,
    name: 'r2-http',
  });
}

export interface R2HybridOptions extends R2HttpOptions {
  /** The Workers `R2Bucket` binding used for reads/writes (no egress). */
  binding: R2BucketLike;
}

/**
 * Hybrid R2 driver: reads/writes go through the native binding (intra-Worker,
 * no egress), while `url()` / `signedUploadUrl()` / `signedMultipart` /
 * server-side `copy()` use the S3 HTTP signer. The best of both for Workers
 * that need browser-facing presigned URLs.
 */
export function r2HybridDriver(o: R2HybridOptions): StorageDriver {
  const binding = r2Driver({ bucket: o.binding, publicBaseUrl: o.publicBaseUrl, name: 'r2-hybrid' });
  const http = r2HttpDriver(o);
  return {
    ...binding,
    name: 'r2-hybrid',
    supportsServerSideCopy: true,
    signedUrl: { supported: true, upload: true },
    url: (key, opts) => http.url(key, opts),
    signedUploadUrl: (key, opts) => http.signedUploadUrl(key, opts),
    signedMultipart: http.signedMultipart,
    copy: (from, to, opts) => http.copy(from, to, opts),
  };
}
