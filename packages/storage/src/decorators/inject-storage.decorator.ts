import { Inject } from '@velajs/vela';
import { StorageService } from '../storage.service';
import { DEFAULT_STORAGE_NAME, storageToken } from '../storage.tokens';

/**
 * Inject the {@link StorageService} for a named bucket.
 *
 * ```ts
 * class UploadService {
 *   constructor(
 *     @InjectStorage() private readonly uploads: StorageService,          // default bucket
 *     @InjectStorage('backups') private readonly backups: StorageService, // named bucket
 *   ) {}
 * }
 * ```
 *
 * The default bucket resolves the `StorageService` class token directly (so
 * plain `@Inject(StorageService)` and `Test.overrideProvider(StorageService)`
 * keep working); named buckets resolve their per-name token.
 */
export function InjectStorage(name: string = DEFAULT_STORAGE_NAME) {
  return Inject(name === DEFAULT_STORAGE_NAME ? StorageService : storageToken(name));
}
