import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor } from '../registry/types';
import { CRON_METADATA, INTERVAL_METADATA } from './schedule.tokens';
import type {
  CronInvocation,
  CronMetadata,
  IntervalInvocation,
  IntervalMetadata,
  ScheduleDecorator,
} from './schedule.types';
import type { CronOptions } from './cron-matcher';
import { parseCronMetadata, parseIntervalMetadata } from './schedule.metadata';
import { registerEntrypointKind } from '../entrypoint/entrypoint.registry';

registerEntrypointKind({ kind: 'schedule:cron', metaKey: CRON_METADATA, level: 'method' });
registerEntrypointKind({ kind: 'schedule:interval', metaKey: INTERVAL_METADATA, level: 'method' });

/**
 * Run a method on a cron schedule. The method receives only its
 * {@link CronInvocation} on every runtime:
 *
 * ```ts
 * @Cron('0 3 * * *', { dialect: 'cloudflare' })
 * async nightly(tick: CronInvocation) {}
 * ```
 */
export function Cron(
  expression: string,
  options: CronOptions = {},
): ScheduleDecorator<CronInvocation> {
  return (target: object, propertyKey: string | symbol) => {
    MetadataRegistry.appendCustomClassMeta<CronMetadata>(
      target.constructor as Constructor,
      CRON_METADATA,
      parseCronMetadata({ ...options, expression, methodName: String(propertyKey) }),
    );
  };
}

/**
 * Run a method every `ms` milliseconds under a Node host (`ScheduleNodeModule`).
 * The method receives only its {@link IntervalInvocation}.
 */
export function Interval(ms: number): ScheduleDecorator<IntervalInvocation> {
  return (target: object, propertyKey: string | symbol) => {
    MetadataRegistry.appendCustomClassMeta<IntervalMetadata>(
      target.constructor as Constructor,
      INTERVAL_METADATA,
      parseIntervalMetadata({ ms, methodName: String(propertyKey) }),
    );
  };
}
