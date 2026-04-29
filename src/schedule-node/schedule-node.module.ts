import type { ProviderOptions, Type } from '../container/types';
import type { DynamicModule } from '../module/types';
import { ScheduleRegistry } from '../schedule/schedule.registry';
import { ScheduleExecutor } from './schedule.executor';

export class ScheduleNodeModule {
  static forRoot(): DynamicModule {
    const providers: Array<Type | ProviderOptions> = [ScheduleRegistry, ScheduleExecutor];
    return { module: ScheduleNodeModule, providers, exports: [ScheduleRegistry, ScheduleExecutor] };
  }
}
