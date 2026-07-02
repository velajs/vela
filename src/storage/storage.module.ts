import { ConfigurableModuleBuilder, Module } from '@velajs/vela';
import { EnvModule } from '../modules/env.module';
import { StorageController } from './storage.controller';
import { StorageManagerService } from './storage-manager.service';
import { StorageService } from './storage.service';
import { STORAGE_OPTIONS } from './storage.tokens';
import type { StorageModuleOptions } from './storage.types';

const { ConfigurableModuleClass } = new ConfigurableModuleBuilder<StorageModuleOptions>({
  moduleName: 'Storage',
  optionsInjectionToken: STORAGE_OPTIONS,
}).build();

// EnvModule.forRoot() is global + dedups by default key, so importing it here is
// safe whether or not the root app also imports it — it guarantees EnvService
// (bucket-by-name resolution) is available.
@Module({
  imports: [EnvModule.forRoot()],
  providers: [StorageManagerService, StorageService],
  controllers: [StorageController],
  exports: [StorageService, StorageManagerService, STORAGE_OPTIONS],
})
export class StorageModule extends ConfigurableModuleClass {}
