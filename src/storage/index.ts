// The HMAC signed-URL util now lives in `src/crypto/` (core consumes it there
// for the URL generator + guard). Re-exported here so `@velajs/vela/storage`'s
// public API is unchanged for existing consumers.
export { signUrl, verifySignedUrl } from '../crypto/signed-url';
export type { SignedUrlOptions } from '../crypto/signed-url';
export { expandPathTemplate, joinStoragePath } from './path-template';
export type {
  StorageBody,
  StorageDriver,
  PresignMethod,
  UploadOptions,
  UploadResult,
  DownloadResult,
  PresignedUrlResult,
} from './storage.types';
