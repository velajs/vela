import { Module } from '../module/decorators';
import type { DynamicModule } from '../module/types';
import { ScheduleRegistry } from './schedule.registry';

/**
 * Zero-config module (Tier C): providers live on the `@Module` bag; the
 * `forRoot()` static is NestJS-parity sugar returning the bare dynamic module
 * (default key — repeated calls dedup).
 */
@Module({
  // Lazy: the @Cron/@Interval discovery pass runs when ScheduleRegistry is
  // first resolved (executor bootstrap, introspection, first dispatch).
  lazy: true,
  providers: [ScheduleRegistry],
  exports: [ScheduleRegistry],
})
export class ScheduleModule {
  static forRoot(): DynamicModule {
    return { module: ScheduleModule };
  }
}
