import { EventDispatcher } from './event-dispatcher';
import { Module } from '../module/decorators';
import { EventEmitter } from './event-emitter.service';

// Lazy: the whole subsystem (emitter + @OnEvent wiring pass) materializes on
// first EventEmitter resolution — an HTTP-only worker that never emits pays
// nothing at cold start. See docs/modules.md "Lazy modules".
@Module({
  lazy: true,
  providers: [EventEmitter, EventDispatcher],
  exports: [EventEmitter, EventDispatcher],
})
export class EventEmitterModule {}
