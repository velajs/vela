import { Module } from '../module/decorators';
import type { DynamicModule } from '../module/types';
import { ScheduleRegistry } from '../schedule/schedule.registry';
import { ScheduleExecutor } from './schedule.executor';

/**
 * Zero-config module (Tier C): providers live on the `@Module` bag; the
 * `forRoot()` static is NestJS-parity sugar returning the bare dynamic module
 * (default key — repeated calls dedup).
 */
@Module({
  providers: [ScheduleRegistry, ScheduleExecutor],
  exports: [ScheduleRegistry, ScheduleExecutor],
})
export class ScheduleNodeModule {
  static forRoot(): DynamicModule {
    return { module: ScheduleNodeModule };
  }
}
