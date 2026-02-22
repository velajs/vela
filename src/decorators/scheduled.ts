import 'reflect-metadata';

const SCHEDULED_METADATA_KEY = 'cloudflare:scheduled';

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
    // Use getOwnMetadata to avoid inheriting metadata from parent classes
    const existing: ScheduledMetadata[] =
      Reflect.getOwnMetadata(SCHEDULED_METADATA_KEY, target.constructor) ?? [];
    existing.push({ cron, methodName: String(propertyKey) });
    Reflect.defineMetadata(SCHEDULED_METADATA_KEY, existing, target.constructor);
  };
}

export function getScheduledMetadata(target: object): ScheduledMetadata[] {
  const ctor = target.constructor ?? target;
  return Reflect.getOwnMetadata(SCHEDULED_METADATA_KEY, ctor) ?? [];
}
