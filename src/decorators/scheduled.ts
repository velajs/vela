import { defineMetadata, getMetadata, registerEntrypointKind } from '@velajs/vela';

const SCHEDULED_METADATA_KEY = 'cloudflare:scheduled';

// Open entrypoint kind: adapters enumerate cron handlers via
// `app.entrypoints.ofKind('cf:scheduled')` — declared next to the decorator.
registerEntrypointKind({ kind: 'cf:scheduled', metaKey: SCHEDULED_METADATA_KEY, level: 'method' });

export interface ScheduledMetadata {
  cron: string;
  methodName: string;
}

/**
 * Marks a method as a scheduled (cron) handler.
 *
 * @example
 * ```ts
 * @Injectable()
 * class WorkerService {
 *   @Scheduled('0 * * * *')
 *   async hourlyCron() {
 *     console.log('Running hourly');
 *   }
 * }
 * ```
 */
export function Scheduled(cron: string): MethodDecorator {
  return (target: object, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
    const existing: ScheduledMetadata[] =
      (getMetadata(SCHEDULED_METADATA_KEY, target.constructor) as ScheduledMetadata[]) ?? [];
    existing.push({ cron, methodName: String(propertyKey) });
    defineMetadata(SCHEDULED_METADATA_KEY, existing, target.constructor);
  };
}

export function getScheduledMetadata(target: object): ScheduledMetadata[] {
  const ctor = target.constructor ?? target;
  return (getMetadata(SCHEDULED_METADATA_KEY, ctor) as ScheduledMetadata[]) ?? [];
}
