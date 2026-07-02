import { Inject, Injectable } from '@velajs/vela';
import { EnvService } from '../services/env.service';
import { R2StorageDriver } from './r2-storage.driver';
import { STORAGE_OPTIONS } from './storage.tokens';
import type { DiskConfig, StorageModuleOptions } from './storage.types';

/**
 * Resolves R2 buckets by binding NAME (via {@link EnvService}) so multiple disks
 * coexist without registering N R2Modules. Drivers are created per call — cheap,
 * and avoids caching a per-request env value on this singleton.
 */
@Injectable()
export class StorageManagerService {
  constructor(
    @Inject(STORAGE_OPTIONS) private readonly options: StorageModuleOptions,
    @Inject(EnvService) private readonly env: EnvService,
  ) {}

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
    const bucket = this.env.get<R2Bucket>(config.binding);
    if (!bucket) {
      throw new Error(`R2 binding "${config.binding}" for disk "${disk}" was not found in env.`);
    }
    return new R2StorageDriver({ disk, bucket, secret: this.env.get<string>('APP_SECRET') });
  }
}
