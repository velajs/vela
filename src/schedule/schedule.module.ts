import { METADATA_KEYS } from '../constants';
import { defineMetadata } from '../metadata';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { InjectionToken, ProviderOptions, Type } from '../container/types';
import type { AsyncModuleOptions, DynamicModule } from '../module/types';
import { ScheduleExecutor } from './schedule.executor';
import { ScheduleRegistry } from './schedule.registry';
import { SCHEDULE_MODULE_OPTIONS } from './schedule.tokens';
import type { ScheduleModuleOptions } from './schedule.types';

function makeScheduleModuleClass() {
  const moduleClass = class ScheduleDynamicModule {} as unknown as Type;
  Object.defineProperty(moduleClass, 'name', { value: 'ScheduleModule' });
  defineMetadata(METADATA_KEYS.MODULE, true, moduleClass);
  return moduleClass;
}

export class ScheduleModule {
  static forRoot(options: ScheduleModuleOptions = {}): DynamicModule {
    const { enableTimers = false } = options;
    const moduleClass = makeScheduleModuleClass();

    const providers: Array<Type | ProviderOptions> = [
      { token: SCHEDULE_MODULE_OPTIONS, useValue: options },
      ScheduleRegistry,
    ];

    const exports: Array<Type | InjectionToken> = [SCHEDULE_MODULE_OPTIONS, ScheduleRegistry];

    if (enableTimers) {
      providers.push(ScheduleExecutor);
      exports.push(ScheduleExecutor);
    }

    MetadataRegistry.setModuleOptions(moduleClass, { exports });

    return { module: moduleClass, providers };
  }

  static forRootAsync(
    options: AsyncModuleOptions<ScheduleModuleOptions> & { enableTimers?: boolean },
  ): DynamicModule {
    const { enableTimers = false } = options;
    const moduleClass = makeScheduleModuleClass();

    const providers: Array<Type | ProviderOptions> = [
      {
        token: SCHEDULE_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      },
      ScheduleRegistry,
    ];

    const exports: Array<Type | InjectionToken> = [SCHEDULE_MODULE_OPTIONS, ScheduleRegistry];

    if (enableTimers) {
      providers.push(ScheduleExecutor);
      exports.push(ScheduleExecutor);
    }

    MetadataRegistry.setModuleOptions(moduleClass, {
      imports: options.imports ?? [],
      exports,
    });

    return { module: moduleClass, providers };
  }
}
