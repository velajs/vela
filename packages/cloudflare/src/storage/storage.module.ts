import { ConfigurableModuleBuilder, Module } from '@velajs/vela';
import { StorageController } from './storage.controller';
import { StorageManagerService } from './storage-manager.service';
import { StorageService } from './storage.service';
import { STORAGE_OPTIONS } from './storage.tokens';
import type { StorageModuleOptions } from './storage.types';

const { ConfigurableModuleClass } = new ConfigurableModuleBuilder<StorageModuleOptions>({
  moduleName: 'Storage',
  optionsInjectionToken: STORAGE_OPTIONS,
}).build();

@Module({
  providers: [StorageManagerService, StorageService],
  controllers: [StorageController],
  exports: [StorageService, StorageManagerService, STORAGE_OPTIONS],
})
export class StorageModule extends ConfigurableModuleClass {}
