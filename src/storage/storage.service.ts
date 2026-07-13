import { Inject, Injectable } from '@velajs/vela';
import {
  joinStoragePath,
  type DownloadResult,
  type PresignedUrlResult,
  type PresignMethod,
  type StorageBody,
  type UploadOptions,
  type UploadResult,
} from '@velajs/vela/storage';
import { StorageManagerService } from './storage-manager.service';
import { STORAGE_OPTIONS } from './storage.tokens';
import type { StorageModuleOptions } from './storage.types';

const DEFAULT_PRESIGN = { defaultExpiry: 3600, maxExpiry: 86400 };

/**
 * Multi-disk storage facade. Applies each disk's (templated) root, resolves the
 * driver, and validates presign expiry. Injectable anywhere via `StorageService`.
 */
@Injectable()
export class StorageService {
  constructor(
    @Inject(STORAGE_OPTIONS) private readonly options: StorageModuleOptions,
    @Inject(StorageManagerService) private readonly manager: StorageManagerService,
  ) {}

  put(
    relativePath: string,
    body: StorageBody,
    options: UploadOptions = {},
    disk?: string,
  ): Promise<UploadResult> {
    const name = this.resolveDisk(disk);
    return this.manager.getDriver(name).upload(body, this.fullPath(relativePath, name), options);
  }

  get(relativePath: string, disk?: string): Promise<DownloadResult> {
    const name = this.resolveDisk(disk);
    return this.manager.getDriver(name).download(this.fullPath(relativePath, name));
  }

  delete(relativePath: string, disk?: string): Promise<void> {
    const name = this.resolveDisk(disk);
    return this.manager.getDriver(name).delete(this.fullPath(relativePath, name));
  }

  exists(relativePath: string, disk?: string): Promise<boolean> {
    const name = this.resolveDisk(disk);
    return this.manager.getDriver(name).exists(this.fullPath(relativePath, name));
  }

  url(
    relativePath: string,
    method: PresignMethod = 'GET',
    expiresIn?: number,
    disk?: string,
  ): Promise<PresignedUrlResult> {
    const name = this.resolveDisk(disk);
    return this.manager
      .getDriver(name)
      .getPresignedUrl(this.fullPath(relativePath, name), method, this.validateExpiry(expiresIn));
  }

  private resolveDisk(disk?: string): string {
    const name = disk ?? this.options.defaultDisk;
    if (!this.manager.hasDisk(name)) throw new Error(`Storage disk "${name}" is not configured.`);
    return name;
  }

  private fullPath(relativePath: string, disk: string): string {
    return joinStoragePath(this.manager.getDiskConfig(disk).root, relativePath);
  }

  private validateExpiry(expiresIn?: number): number {
    const cfg = this.options.presignedUrl ?? DEFAULT_PRESIGN;
    const value = expiresIn ?? cfg.defaultExpiry;
    // `Number.isFinite` rejects NaN — otherwise `NaN < 1 || NaN > max` is false,
    // NaN slips through, signUrl omits `expires`, and the URL never expires.
    if (!Number.isFinite(value) || value < 1 || value > cfg.maxExpiry) {
      throw new Error(`Presigned URL expiry ${value}s is out of range (1–${cfg.maxExpiry}s).`);
    }
    return value;
  }
}
