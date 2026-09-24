import { Module } from '../module/decorators';
import { defineModule } from '../module/define-module';
import { DEFAULT_MODULE_KEY } from '../module/module-identity';
import { ScheduleRegistryModule } from '../schedule/schedule.module';
import { ScheduleExecutor } from './schedule.executor';

/** `ScheduleNodeModule` takes no options; `forRoot()` is the uniform entry. */
export type ScheduleNodeModuleOptions = Record<never, never>;

// The bare import's key: `forRoot()` and `imports: [ScheduleNodeModule]` are
// one instance, so an application never runs two executors (every job twice).
const { ConfigurableModuleClass } = defineModule<ScheduleNodeModuleOptions>({
  name: 'ScheduleNode',
  key: () => DEFAULT_MODULE_KEY,
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
