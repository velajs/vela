import {
  signUrl,
  type DownloadResult,
  type PresignedUrlResult,
  type PresignMethod,
  type StorageBody,
  type StorageDriver,
  type UploadOptions,
  type UploadResult,
} from '@velajs/vela/storage';

/** Base path of the StorageController presign-proxy route. */
export const STORAGE_ROUTE_BASE = '/storage';

export interface R2StorageDriverConfig {
  disk: string;
  bucket: R2Bucket;
  /** HMAC secret for presigned URLs (typically env.APP_SECRET). */
  secret?: string;
}

/** {@link StorageDriver} over a Cloudflare R2 bucket. */
export class R2StorageDriver implements StorageDriver {
  constructor(private readonly config: R2StorageDriverConfig) {}

  async upload(body: StorageBody, path: string, options: UploadOptions): Promise<UploadResult> {
    await this.config.bucket.put(
      path,
      body as ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null,
      {
        httpMetadata: options.mimeType ? { contentType: options.mimeType } : undefined,
        customMetadata: options.metadata,
      },
    );
    return {
      path,
      disk: this.config.disk,
      size: options.size,
      mimeType: options.mimeType ?? 'application/octet-stream',
      uploadedAt: new Date(),
    };
  }

  async download(path: string): Promise<DownloadResult> {
    const obj = await this.config.bucket.get(path);
    if (!obj) throw new Error(`Storage object not found at "${path}".`);
    return {
      toStream: () => obj.body as ReadableStream,
      toArrayBuffer: () => obj.arrayBuffer(),
      toText: () => obj.text(),
      contentType: obj.httpMetadata?.contentType ?? 'application/octet-stream',
      size: obj.size,
      metadata: obj.customMetadata,
    };
  }

  async delete(path: string): Promise<void> {
    await this.config.bucket.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    return (await this.config.bucket.head(path)) !== null;
  }

  async getPresignedUrl(
    path: string,
    method: PresignMethod,
    expiresIn: number,
  ): Promise<PresignedUrlResult> {
    if (!this.config.secret) {
      throw new Error('A signing secret is required for presigned URLs (set APP_SECRET).');
    }
    // Defend the direct-driver path too: a non-finite/non-positive expiry would
    // make signUrl omit `expires`, yielding a never-expiring URL.
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error(`Invalid presigned URL expiry: ${expiresIn}s (must be a positive number).`);
    }
    const routePath = `${STORAGE_ROUTE_BASE}/${this.config.disk}/${path}`;
    const url = await signUrl(`${routePath}?method=${method}`, this.config.secret, { expiresIn });
    return { url, method, expiresIn, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }
}
