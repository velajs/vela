import type { InjectionToken, ProviderOptions, Type } from '../container/types';
import type { AsyncModuleOptions, DynamicModule } from '../module/types';
import { ScheduleExecutor } from './schedule.executor';
import { ScheduleRegistry } from './schedule.registry';
import { SCHEDULE_MODULE_OPTIONS } from './schedule.tokens';
import type { ScheduleModuleOptions } from './schedule.types';

export class ScheduleModule {
  static forRoot(options: ScheduleModuleOptions = {}): DynamicModule {
    const { enableTimers = false } = options;

    const providers: Array<Type | ProviderOptions> = [
      { provide: SCHEDULE_MODULE_OPTIONS, useValue: options },
      ScheduleRegistry,
    ];

    const exports: Array<Type | InjectionToken> = [SCHEDULE_MODULE_OPTIONS, ScheduleRegistry];

    if (enableTimers) {
      providers.push(ScheduleExecutor);
      exports.push(ScheduleExecutor);
    }

    return { module: ScheduleModule, providers, exports };
  }

  static forRootAsync(
    options: AsyncModuleOptions<ScheduleModuleOptions> & { enableTimers?: boolean },
  ): DynamicModule {
    const { enableTimers = false } = options;

    const providers: Array<Type | ProviderOptions> = [
      {
        provide: SCHEDULE_MODULE_OPTIONS,
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

    return {
      module: ScheduleModule,
      imports: options.imports ?? [],
      providers,
      exports,
    };
  }
}
