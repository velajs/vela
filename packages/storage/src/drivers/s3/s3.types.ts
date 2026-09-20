export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3DriverOptions {
  /**
   * Service endpoint. Examples:
   * - AWS:        `https://s3.us-east-1.amazonaws.com`
   * - R2:         `https://<accountId>.r2.cloudflarestorage.com`
   * - MinIO:      `http://localhost:9000`
   */
  endpoint: string;
  /** AWS region (`auto` for R2). */
  region: string;
  bucket: string;
  credentials: S3Credentials;
  /** Path-style addressing (`endpoint/bucket/key`). Required by MinIO/R2/most non-AWS. */
  forcePathStyle?: boolean;
  /** CDN/public origin; when set, `url()` returns a permanent link unless signing is forced. */
  publicBaseUrl?: string;
  /** Default `expiresIn` (seconds) for presigned URLs. Default 3600. */
  defaultUrlExpiresIn?: number;
  /** Override the fetch implementation (tests). */
  fetch?: typeof fetch;
  /** Friendly driver name (defaults to `s3`). */
  name?: string;
}
