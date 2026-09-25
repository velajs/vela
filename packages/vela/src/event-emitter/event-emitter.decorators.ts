import { isValidationSchema } from '../validation/parse-schema';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor } from '../registry/types';
import { ON_SCOPED_EVENT_METADATA } from './event-emitter.tokens';
import type { ScopedEventMetadata } from './event-emitter.types';
import type { EventDefinition, EventPayload } from './event-definition';

export type EventListenerDecorator<Payload> = <Handler extends (payload: Payload) => unknown>(
  target: object,
  propertyKey: string | symbol,
  descriptor: TypedPropertyDescriptor<Handler>,
) => void;

/** Subscribe to a validated event definition in its execution scope. */
export function OnEvent<Event extends EventDefinition>(
  event: Event,
): EventListenerDecorator<EventPayload<Event>> {
  if (
    !event ||
    typeof event !== 'object' ||
    typeof event.name !== 'string' ||
    !isValidationSchema(event.schema)
  )
    throw new TypeError('OnEvent requires an event definition.');
  return (target, propertyKey) => {
    MetadataRegistry.appendCustomClassMeta<ScopedEventMetadata>(
      target.constructor as Constructor,
      ON_SCOPED_EVENT_METADATA,
      { definition: event, methodName: propertyKey },
    );
  };
}
