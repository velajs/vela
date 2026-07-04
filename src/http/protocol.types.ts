import type { SignedUpload, UploadResult, UploadedPart } from '../storage.types';

// Wire shapes shared between the HTTP controller and the browser client.
// Zero runtime — imported `type`-only across the client boundary.

// ---- requests ----
export interface SignUploadRequest {
  key: string;
  contentType?: string;
  size?: number;
  metadata?: Record<string, string>;
  expiresIn?: number;
}

export interface MultipartCreateRequest {
  key: string;
  contentType?: string;
  metadata?: Record<string, string>;
  partSize?: number;
}

export interface SignPartRequest {
  key: string;
  uploadId: string;
  partNumber: number;
}

export interface MultipartCompleteRequest {
  key: string;
  uploadId: string;
  parts: UploadedPart[];
}

export interface MultipartAbortRequest {
  key: string;
  uploadId: string;
}

export interface DeleteRequest {
  keys: string[];
}

// ---- responses ----
export interface SignUploadResponse {
  key: string;
  upload: SignedUpload;
}

export interface MultipartCreateResponse {
  key: string;
  uploadId: string;
  partSize: number;
}

export interface SignPartResponse {
  partNumber: number;
  method: 'PUT';
  url: string;
  headers?: Record<string, string>;
}

export type MultipartCompleteResponse = UploadResult;

export interface OkResponse {
  ok: true;
}

/** JSON-safe {@link StoredFile} projection (no body accessors). */
export interface StoredFileMeta {
  key: string;
  name: string;
  size: number;
  type: string;
  lastModified?: number;
  etag?: string;
  metadata?: Record<string, string>;
}

export interface ListResponse {
  items: StoredFileMeta[];
  prefixes?: string[];
  cursor?: string;
}

export interface SignDownloadResponse {
  url: string;
  expiresAt: number;
}

// ---- error envelope (non-2xx) ----
export type StorageWireErrorCode =
  | 'forbidden'
  | 'invalid_key'
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'capability_unsupported'
  | 'upstream_error';

export interface StorageErrorBody {
  error: { code: StorageWireErrorCode; message: string };
}
