import { defineMetadata, getMetadata, parseCron, registerEntrypointKind } from '@velajs/vela';

const SCHEDULED_METADATA_KEY = 'cloudflare:scheduled';

// Open entrypoint kind: adapters enumerate cron handlers via
// `app.entrypoints.ofKind('cf:scheduled')` — declared next to the decorator.
registerEntrypointKind({ kind: 'cf:scheduled', metaKey: SCHEDULED_METADATA_KEY, level: 'method' });

export interface ScheduledMetadata {
  cron: string;
  methodName: string;
}

/** Compatible with the existing programmatic scheduled() entrypoint. */
export interface ScheduledEvent {
  readonly cron: string;
  readonly scheduledTime?: number;
}

/** Native controller passed unchanged to a Worker handler. Call noRetry on its receiver. */
export interface ScheduledController extends ScheduledEvent {
  readonly scheduledTime: number;
  noRetry(): void;
}

export interface ScheduledContext {
  waitUntil(promise: Promise<unknown>): void;
}

export type ScheduledHandler<Env extends object = object> = (
  controller: ScheduledController,
  env: Env,
  context: ScheduledContext,
) => void | Promise<void>;

export function parseScheduledMetadata(value: unknown): ScheduledMetadata {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('cron' in value) ||
    typeof value.cron !== 'string' ||
    !('methodName' in value) ||
    typeof value.methodName !== 'string' ||
    !parseCron(value.cron, { dialect: 'cloudflare' })
  ) {
    throw new TypeError('Invalid Cloudflare scheduled metadata');
  }
  return { cron: value.cron, methodName: value.methodName };
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
  if (!parseCron(cron, { dialect: 'cloudflare' })) {
    throw new TypeError(`Invalid Cloudflare cron expression: ${cron}`);
  }
  return (target: object, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
    // Work with a validated copy rather than mutating the registry's handler list.
    const existing = getScheduledMetadata(target);
    existing.push({ cron, methodName: String(propertyKey) });
    defineMetadata(SCHEDULED_METADATA_KEY, existing, target.constructor);
  };
}

export function getScheduledMetadata(target: object): ScheduledMetadata[] {
  const ctor = typeof target === 'function' ? target : target.constructor;
  const value: unknown = getMetadata(SCHEDULED_METADATA_KEY, ctor);
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('Invalid Cloudflare scheduled metadata list');
  return value.map(parseScheduledMetadata);
}
