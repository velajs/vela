import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor } from '../registry/types';
import { ON_EVENT_METADATA, ON_SCOPED_EVENT_METADATA } from './event-emitter.tokens';
import type { OnEventMetadata, ScopedEventMetadata } from './event-emitter.types';
import type { EventDefinition, EventPayload } from './event-definition';

export type EventListenerDecorator<Payload> = <Handler extends (payload: Payload) => unknown>(
  target: object,
  propertyKey: string | symbol,
  descriptor: TypedPropertyDescriptor<Handler>,
) => void;

/** String events retain legacy application subscriptions; definitions opt into scoped dispatch. */
export function OnEvent(event: string): MethodDecorator;
export function OnEvent<Event extends EventDefinition>(
  event: Event,
): EventListenerDecorator<EventPayload<Event>>;
export function OnEvent(
  event: string | EventDefinition,
): (target: object, propertyKey: string | symbol) => void {
  return (target, propertyKey) => {
    if (typeof event !== 'string') {
      MetadataRegistry.appendCustomClassMeta<ScopedEventMetadata>(
        target.constructor as Constructor,
        ON_SCOPED_EVENT_METADATA,
        { definition: event, methodName: propertyKey },
      );
      return;
    }
    MetadataRegistry.appendCustomClassMeta<OnEventMetadata>(
      target.constructor as Constructor,
      ON_EVENT_METADATA,
      { event, methodName: String(propertyKey) },
    );
  };
}
