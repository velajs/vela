import { EventDispatcher } from './event-dispatcher';
import { Module } from '../module/decorators';
import { defineModule } from '../module/define-module';
import { DEFAULT_MODULE_KEY } from '../module/module-identity';
import { EventEmitter } from './event-emitter.service';
import { EventEmitterSubscriber } from './event-emitter.subscriber';

/** `EventEmitterModule` takes no options; `forRoot()` is the uniform entry. */
export type EventEmitterModuleOptions = Record<never, never>;

// The bare import's key: `forRoot()` and `imports: [EventEmitterModule]` are
// one instance, with one emitter.
const { ConfigurableModuleClass } = defineModule<EventEmitterModuleOptions>({
  name: 'EventEmitter',
  key: () => DEFAULT_MODULE_KEY,
});

// Lazy: the whole subsystem (emitter + @OnEvent wiring pass) materializes on
// first EventEmitter resolution — an HTTP-only worker that never emits pays
// nothing at cold start. See docs/modules.md "Lazy modules".
@Module({
  lazy: true,
  providers: [EventEmitter, EventEmitterSubscriber, EventDispatcher],
  exports: [EventEmitter, EventDispatcher],
})
export class EventEmitterModule extends ConfigurableModuleClass {}
