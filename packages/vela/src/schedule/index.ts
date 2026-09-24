// @velajs/vela/schedule — cron and interval jobs. The seams runtime adapters
// use to run them (invokeScheduledJob, the invocation seed, metadata parsing and
// diagnostics) live on @velajs/vela/module-kit.
import '../metadata';

export { ScheduleModule } from './schedule.module';
export type { ScheduleModuleOptions } from './schedule.module';
export { ScheduleRegistry } from './schedule.registry';
export type { RegisteredCronJob, RegisteredIntervalJob } from './schedule.registry';
export { Cron, Interval } from './schedule.decorators';
export { CRON_METADATA, INTERVAL_METADATA, SCHEDULE_DISPATCH } from './schedule.tokens';
export type {
  CronInvocation,
  CronMetadata,
  IntervalInvocation,
  IntervalMetadata,
  ScheduleDecorator,
  ScheduleDispatchMode,
  ScheduleJobRef,
  ScheduleInvocation,
} from './schedule.types';
export { parseCron } from './cron-matcher';
export type { CronMatcher, CronOptions } from './cron-matcher';
