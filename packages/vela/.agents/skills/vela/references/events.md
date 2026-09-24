# Events (`EventEmitterModule`)

An in-process event bus with decorator-based listeners, on the subpath `@velajs/vela/events`. The module is lazy — the emitter and `@OnEvent` wiring materialize on first `EventEmitter` resolution.

## Setup

`EventEmitterModule` takes no options. Import it bare or through `EventEmitterModule.forRoot()`, the uniform entry: both forms are one instance (one emitter), so a library importing one form and the app the other share it. List your listener providers:

```ts
import { EventEmitterModule, EventEmitter, OnEvent } from '@velajs/vela/events';

@Injectable()
class UserListener {
  @OnEvent('user.created')
  onUserCreated(name: string) { /* react */ }
}

@Module({ imports: [EventEmitterModule], providers: [UserListener] })
class AppModule {}
```

`@OnEvent(string)` registers legacy subscriptions via discovery. Singleton/transient listeners keep an application instance; request-scoped listeners (including consumers of request dependencies) now run in a fresh managed invocation per listener delivery, resolved from their exact module owner. These fresh invocations do not inherit HTTP/tenant authority.

## Emitting

Inject `EventEmitter` and await `emit`. It runs exact handlers concurrently, then each matching wildcard group; a failure rejects and skips later groups:

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

`EventEmitter` API: `on(event, handler)`, `once(event, handler)`, `off(event, handler)`, `emit(event, ...args)` (async — awaits handlers via `Promise.all`; there is no separate `emitAsync`), `emitWithOptions(event, { settlement: 'complete' }, ...args)` (snapshots and settles every matching listener), `removeAllListeners(event?)`, `listenerCount(event)`. Handlers may be sync or async (`EventHandler = (...args) => void | Promise<void>`).

## Wildcards

Event names are dot-segmented. `*` matches exactly one segment; `**` matches any depth:

```ts nocheck
@OnEvent('user.*')    // matches 'user.created', NOT 'user.profile.updated'
@OnEvent('user.**')   // matches 'user.created' AND 'user.profile.updated'
```

## Lazy note

Because `EventEmitterModule` is lazy, the emitter isn't constructed until something resolves it. A listener that must run needs the emitter to be reached (e.g. another provider injecting `EventEmitter`, an emit call, or `app.materializeLazyModules()` during warmup). Legacy application listener construction follows the lazy synchronous initialization rule (see `lazy-and-lifecycle.md`). Scoped definitions resolve listeners asynchronously at dispatch.

## Validated invocation events

Use `defineEvent(name, schema)` or `defineEventVocabulary({ 'user.created': schema })` for shared Standard Schema/legacy parser contracts. `EventInput<typeof event>` and `EventPayload<typeof event>` preserve wire input and transformed output. `@OnEvent(eventDefinition)` checks the payload type and opts into scoped dispatch; it does not also subscribe to string emits. Register the listener as an ordinary module provider.

`EventEmitterModule` exports `EventDispatcher`. `await dispatcher.emit(event, input)` validates once and runs all matching listeners in one fresh managed invocation. `dispatcher.inScope(container)` binds an existing same-application managed invocation; its `emit(event,input)` and `emitUnknown(event,unknown)` validate before dispatch, and `defer(event,input)` queues work for managed completion. Use `getRequestContainer(context)` inside HTTP; elsewhere create an execution scope and await its `finish()`. Never finish an HTTP-owned scope early. Closed/foreign/unmanaged scopes reject. Await immediate emits; do not mutate deferred payloads before completion.

Scoped dispatch resolves listeners asynchronously from their exact module owners, including lazy providers. Every listener settles before rejection: one failure is unchanged, multiple failures form AggregateError. Definitions sharing a name must share the same schema object. Schema errors reject before constructing listeners. Deferred work retains scope resources and rejects invocation completion on failure.

`once` consumption happens before invocation, even under recursion/concurrency/failure; `off` accepts the original callback. Local delivery, deferred work, and CRUD afterCommit notifications are not a durable outbox. Keep event-source's standalone replay/notifier contracts separate.
