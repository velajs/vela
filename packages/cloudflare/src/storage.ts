import './vela-env';
/**
 * `@velajs/cloudflare/storage`: the R2 driver for `@velajs/storage`, resolved
 * from each application's `ENV` by binding name.
 */
export { r2Storage } from './storage/r2-storage';
export type { R2StorageOptions } from './storage/r2-storage';
