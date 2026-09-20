import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor } from '../registry/types';
import { ON_EVENT_METADATA } from './event-emitter.tokens';
import type { OnEventMetadata } from './event-emitter.types';

export function OnEvent(event: string): MethodDecorator {
  return (target: object, propertyKey: string | symbol) => {
    MetadataRegistry.appendCustomClassMeta<OnEventMetadata>(
      target.constructor as Constructor,
      ON_EVENT_METADATA,
      { event, methodName: String(propertyKey) },
    );
  };
}
