import { CRON_METADATA, INTERVAL_METADATA } from './schedule.tokens';
import type { CronMetadata, IntervalMetadata } from './schedule.types';

export function Cron(expression: string): MethodDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const existing: CronMetadata[] =
      (Reflect.getMetadata(CRON_METADATA, target.constructor) as CronMetadata[] | undefined) ?? [];
    existing.push({ expression, methodName: String(propertyKey) });
    Reflect.defineMetadata(CRON_METADATA, existing, target.constructor);
  };
}

export function Interval(ms: number): MethodDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const existing: IntervalMetadata[] =
      (Reflect.getMetadata(INTERVAL_METADATA, target.constructor) as IntervalMetadata[] | undefined) ?? [];
    existing.push({ ms, methodName: String(propertyKey) });
    Reflect.defineMetadata(INTERVAL_METADATA, existing, target.constructor);
  };
}
