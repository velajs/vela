import { METADATA_KEYS } from '../constants';
import { defineMetadata } from '../metadata';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { Type } from '../container/types';
import type { ProviderOptions } from '../container/types';
import type { DynamicModule } from '../module/types';
import { ScheduleExecutor } from './schedule.executor';
import { ScheduleRegistry } from './schedule.registry';
import { SCHEDULE_MODULE_OPTIONS } from './schedule.tokens';
import type { ScheduleModuleOptions } from './schedule.types';
import type { InjectionToken } from '../container/types';

export class ScheduleModule {
  static forRoot(options: ScheduleModuleOptions = {}): DynamicModule {
    const { enableTimers = false } = options;

    const moduleClass = class ScheduleDynamicModule {} as unknown as Type;
    Object.defineProperty(moduleClass, 'name', { value: 'ScheduleModule' });
    defineMetadata(METADATA_KEYS.MODULE, true, moduleClass);

    const providers: Array<Type | ProviderOptions> = [
      { token: SCHEDULE_MODULE_OPTIONS, useValue: options },
      ScheduleRegistry,
    ];

    const exports: Array<Type | InjectionToken> = [
      SCHEDULE_MODULE_OPTIONS,
      ScheduleRegistry,
    ];

    if (enableTimers) {
      providers.push(ScheduleExecutor);
      exports.push(ScheduleExecutor);
    }

    MetadataRegistry.setModuleOptions(moduleClass, { exports });

    return {
      module: moduleClass,
      providers,
    };
  }
}
