/** Body payloads accepted by uploads. */
export type StorageBody = ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null;

export type PresignMethod = 'GET' | 'PUT' | 'DELETE' | 'HEAD';

export interface UploadOptions {
  size?: number;
  mimeType?: string;
  metadata?: Record<string, string>;
}

export interface UploadResult {
  path: string;
  disk: string;
  size?: number;
  mimeType: string;
  uploadedAt: Date;
}

export interface DownloadResult {
  toStream(): ReadableStream;
  toArrayBuffer(): Promise<ArrayBuffer>;
  toText(): Promise<string>;
  contentType: string;
  size: number;
  metadata?: Record<string, string>;
}

export interface PresignedUrlResult {
  url: string;
  method: PresignMethod;
  expiresIn: number;
  expiresAt: Date;
}

/**
 * Runtime-agnostic storage driver contract. Implement per backend (R2 in
 * `@velajs/cloudflare`, and e.g. S3/GCS elsewhere) so the manager/service and
 * multi-disk logic stay driver-independent.
 */
export interface StorageDriver {
  upload(body: StorageBody, path: string, options: UploadOptions): Promise<UploadResult>;
  download(path: string): Promise<DownloadResult>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  getPresignedUrl(path: string, method: PresignMethod, expiresIn: number): Promise<PresignedUrlResult>;
}
