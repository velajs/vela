import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor } from '../registry/types';
import { CRON_METADATA, INTERVAL_METADATA } from './schedule.tokens';
import type { CronMetadata, IntervalMetadata } from './schedule.types';

export function Cron(expression: string): MethodDecorator {
  return (target: object, propertyKey: string | symbol) => {
    MetadataRegistry.appendCustomClassMeta<CronMetadata>(
      target.constructor as Constructor,
      CRON_METADATA,
      { expression, methodName: String(propertyKey) },
    );
  };
}

export function Interval(ms: number): MethodDecorator {
  return (target: object, propertyKey: string | symbol) => {
    MetadataRegistry.appendCustomClassMeta<IntervalMetadata>(
      target.constructor as Constructor,
      INTERVAL_METADATA,
      { ms, methodName: String(propertyKey) },
    );
  };
}
