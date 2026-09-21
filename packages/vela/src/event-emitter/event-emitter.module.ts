import { EventDispatcher } from './event-dispatcher';
import { Module } from '../module/index';
import { EventEmitter } from './event-emitter.service';
import { EventEmitterSubscriber } from './event-emitter.subscriber';

// Lazy: the whole subsystem (emitter + @OnEvent wiring pass) materializes on
// first EventEmitter resolution — an HTTP-only worker that never emits pays
// nothing at cold start. See docs/modules.md "Lazy modules".
@Module({
  lazy: true,
  providers: [EventEmitter, EventEmitterSubscriber, EventDispatcher],
  exports: [EventEmitter, EventDispatcher],
})
export class EventEmitterModule {}
