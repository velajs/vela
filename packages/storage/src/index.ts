// Public surface of @velajs/storage (the `.` entry).
// NOTE: drivers live behind their own subpaths (`./drivers/*`) so importing
// the contract/module never pulls `aws4fetch` or a specific backend.

// --- Facade ---------------------------------------------------------------
export { Storage, createStorage } from './storage.facade';
export type { FileHandle } from './storage.facade';

// --- DI: module / service / tokens / decorator ----------------------------
export { StorageModule } from './storage.module';
export type {
  StorageStructuralOption,
  StorageModuleOptions,
  StorageModuleAsyncOptions,
} from './storage.module';
export { StorageService, lazyDriver } from './storage.service';
export type { StorageServiceOptions } from './storage.service';
export { InjectStorage } from './decorators/inject-storage.decorator';
export { DEFAULT_STORAGE_NAME, storageDriverBuilder, storageToken } from './storage.tokens';

// --- HTTP controller (P1) ---
export { createStorageController } from './storage.controller';
export type { ResolvedHttpOptions } from './storage.controller';
export type { StorageHttpOptions } from './storage.module';
export type {
  StorageAction,
  StorageAuthContext,
  StorageAuthResult,
  StorageAuthorizer,
} from './http/authorizer.types';
export type {
  SignUploadRequest,
  SignUploadResponse,
  MultipartCreateRequest,
  MultipartCreateResponse,
  SignPartRequest,
  SignPartResponse,
  MultipartCompleteRequest,
  MultipartCompleteResponse,
  MultipartAbortRequest,
  DeleteRequest,
  ListResponse,
  StoredFileMeta,
  SignDownloadResponse,
  OkResponse,
  StorageWireErrorCode,
  StorageErrorBody,
} from './http/protocol.types';

// --- Errors ---------------------------------------------------------------
export { StorageError, isAbort } from './storage.error';
export type { StorageErrorCode, StorageErrorOptions } from './storage.error';

// --- Key helpers ----------------------------------------------------------
export { isSafeKey, sanitizeKey, normalizePrefix, joinKey, stripPrefix } from './object-key';

// --- Contract types -------------------------------------------------------
export type {
  Body,
  PartBody,
  OperationOptions,
  RetryOptions,
  RetryBackoffContext,
  UploadProgress,
  MultipartOptions,
  UploadOptions,
  UploadResult,
  ByteRange,
  DownloadOptions,
  StoredFile,
  StoredFileMetadata,
  ListOptions,
  ListResult,
  MetadataListResult,
  DeleteManyOptions,
  DeleteManyError,
  DeleteManyResult,
  UrlOptions,
  SignUploadOptions,
  SignedUpload,
  SignedUrlCapability,
  CreateMultipartOptions,
  UploadedPart,
  MultipartUpload,
  SignedMultipartCreate,
  SignedPart,
  SignedMultipartCapability,
  StorageDriver,
  StorageCapabilities,
  StorageHooks,
  StorageHookEvent,
  StorageOptions,
} from './storage.types';
