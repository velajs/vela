import { Module } from '../module/decorators';
import { defineModule } from '../module/define-module';
import { ScheduleRegistryModule } from '../schedule/schedule.module';
import { ScheduleExecutor } from './schedule.executor';

/** `ScheduleNodeModule` takes no options; `forRoot()` is the uniform entry. */
export type ScheduleNodeModuleOptions = Record<never, never>;

const { ConfigurableModuleClass } = defineModule<ScheduleNodeModuleOptions>({
  name: 'ScheduleNode',
});

/**
 * Runs the application's `@Cron`/`@Interval` jobs in a long-lived Node
 * process. It shares the application's one `ScheduleRegistry` with
 * `ScheduleModule`, so importing both keeps a single registry.
 */
@Module({
  imports: [ScheduleRegistryModule],
  providers: [ScheduleExecutor],
  exports: [ScheduleRegistryModule, ScheduleExecutor],
})
export class ScheduleNodeModule extends ConfigurableModuleClass {}
