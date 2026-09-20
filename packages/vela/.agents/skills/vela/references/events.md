# Events (`EventEmitterModule`)

An in-process event bus with decorator-based listeners. On the main export `@velajs/vela`. The module is lazy — the emitter and `@OnEvent` wiring materialize on first `EventEmitter` resolution.

## Setup

`EventEmitterModule` is a plain module (no `forRoot`, no options). Import it and list your listener providers:

```ts
import { EventEmitterModule, EventEmitter, OnEvent } from '@velajs/vela';

@Injectable()
class UserListener {
  @OnEvent('user.created')
  onUserCreated(name: string) { /* react */ }
}

@Module({ imports: [EventEmitterModule], providers: [UserListener] })
class AppModule {}
```

`@OnEvent(event)` takes only the event string (no options argument). Listeners auto-subscribe at bootstrap via discovery.

## Emitting

Inject `EventEmitter` and call `emit` (it is async and awaits all handlers):

```ts
@Injectable()
class SignupService {
  constructor(private readonly events: EventEmitter) {}
  async register(name: string) {
    // ... create user ...
    await this.events.emit('user.created', name);   // event, ...args
  }
}
```

`EventEmitter` API: `on(event, handler)`, `once(event, handler)`, `off(event, handler)`, `emit(event, ...args)` (async — awaits handlers via `Promise.all`; there is no separate `emitAsync`), `removeAllListeners(event?)`, `listenerCount(event)`. Handlers may be sync or async (`EventHandler = (...args) => void | Promise<void>`).

## Wildcards

Event names are dot-segmented. `*` matches exactly one segment; `**` matches any depth:

```ts
@OnEvent('user.*')    // matches 'user.created', NOT 'user.profile.updated'
@OnEvent('user.**')   // matches 'user.created' AND 'user.profile.updated'
```

## Lazy note

Because `EventEmitterModule` is lazy, the emitter isn't constructed until something resolves it. A listener that must run needs the emitter to be reached (e.g. another provider injecting `EventEmitter`, an emit call, or `app.materializeLazyModules()` during warmup). Keep listeners and the emitter fully synchronous (the lazy sync-seam rule — see `lazy-and-lifecycle.md`).
