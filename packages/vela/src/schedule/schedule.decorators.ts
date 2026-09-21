import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor } from '../registry/types';
import { CRON_METADATA, INTERVAL_METADATA } from './schedule.tokens';
import type { CronMetadata, IntervalMetadata } from './schedule.types';
import type { CronOptions } from './cron-matcher';
import { parseCronMetadata, parseIntervalMetadata } from './schedule.metadata';
import { registerEntrypointKind } from '../entrypoint/entrypoint.registry';

registerEntrypointKind({ kind: 'schedule:cron', metaKey: CRON_METADATA, level: 'method' });
registerEntrypointKind({ kind: 'schedule:interval', metaKey: INTERVAL_METADATA, level: 'method' });

export function Cron(expression: string, options: CronOptions = {}): MethodDecorator {
  return (target: object, propertyKey: string | symbol) => {
    MetadataRegistry.appendCustomClassMeta<CronMetadata>(
      target.constructor as Constructor,
      CRON_METADATA,
      parseCronMetadata({ ...options, expression, methodName: String(propertyKey) }),
    );
  };
}

export function Interval(ms: number): MethodDecorator {
  return (target: object, propertyKey: string | symbol) => {
    MetadataRegistry.appendCustomClassMeta<IntervalMetadata>(
      target.constructor as Constructor,
      INTERVAL_METADATA,
      parseIntervalMetadata({ ms, methodName: String(propertyKey) }),
    );
  };
}
