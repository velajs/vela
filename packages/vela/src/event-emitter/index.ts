// @velajs/vela/events — in-process events: EventEmitterModule, @OnEvent and
// typed event vocabularies.
import '../metadata';

export { EventEmitterModule } from './event-emitter.module';
export { EventEmitter } from './event-emitter.service';
export { EventEmitterSubscriber } from './event-emitter.subscriber';
export { OnEvent } from './event-emitter.decorators';
export { ON_EVENT_METADATA } from './event-emitter.tokens';
export type { EventHandler, OnEventMetadata, EventEmitOptions } from './event-emitter.types';
export { defineEvent, defineEventVocabulary } from './event-definition';
export type {
  EventDefinition,
  EventVocabulary,
  EventInput,
  EventPayload,
} from './event-definition';
export { EventDispatcher } from './event-dispatcher';
export type { ScopedEventDispatcher } from './event-dispatcher';
export type { EventListenerDecorator } from './event-emitter.decorators';
