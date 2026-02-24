import { ON_EVENT_METADATA } from './event-emitter.tokens';
import type { OnEventMetadata } from './event-emitter.types';

export function OnEvent(event: string): MethodDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const existing: OnEventMetadata[] =
      (Reflect.getMetadata(ON_EVENT_METADATA, target.constructor) as OnEventMetadata[] | undefined) ?? [];
    existing.push({ event, methodName: String(propertyKey) });
    Reflect.defineMetadata(ON_EVENT_METADATA, existing, target.constructor);
  };
}
