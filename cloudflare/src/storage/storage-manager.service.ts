import { Inject, Injectable } from '@velajs/vela';
import { R2StorageDriver } from './r2-storage.driver';
import { STORAGE_OPTIONS } from './storage.tokens';
import type { DiskConfig, StorageModuleOptions } from './storage.types';

@Injectable()
export class StorageManagerService {
  constructor(@Inject(STORAGE_OPTIONS) private readonly options: StorageModuleOptions) {}

  hasDisk(disk: string): boolean {
    return this.options.disks.some((d) => d.disk === disk);
  }

  getDiskConfig(disk: string): DiskConfig {
    const config = this.options.disks.find((d) => d.disk === disk);
    if (!config) throw new Error(`Storage disk "${disk}" is not configured.`);
    return config;
  }

  getDriver(disk: string): R2StorageDriver {
    const config = this.getDiskConfig(disk);
    return new R2StorageDriver({ disk, bucket: config.bucket, secret: this.options.secret });
  }
}
