import type { ProviderOptions, Type } from '../container/types';
import type { DynamicModule } from '../module/types';
import { ScheduleRegistry } from './schedule.registry';

export class ScheduleModule {
  static forRoot(): DynamicModule {
    const providers: Array<Type | ProviderOptions> = [ScheduleRegistry];
    return { module: ScheduleModule, providers, exports: [ScheduleRegistry] };
  }
}
