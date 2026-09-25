# Events (`EventEmitterModule`)

Validated, scoped event listeners live on `@velajs/vela/events`. Import the lazy
`EventEmitterModule` bare or with `forRoot()`; both forms share one application instance.

```ts
import { z } from 'zod';
import { EventEmitterModule, EventDispatcher, OnEvent, defineEvent } from '@velajs/vela/events';

const userCreated = defineEvent('user.created', z.object({ name: z.string() }));

@Injectable()
class UserListener {
  @OnEvent(userCreated)
  onUserCreated(payload: { name: string }) { /* react */ }
}

@Module({ imports: [EventEmitterModule], providers: [UserListener] })
class AppModule {}

@Injectable()
class SignupService {
  constructor(private readonly events: EventDispatcher) {}
  async register(name: string) {
    await this.events.emit(userCreated, { name });
  }
}
```

Use `defineEvent(name, schema)` or `defineEventVocabulary({ 'user.created': schema })`
with Standard Schema validators or DTO descriptors. `EventInput<typeof event>`
and `EventPayload<typeof event>` preserve input and transformed output types.
`@OnEvent` requires a definition and checks the handler payload. Register listeners
as ordinary module providers; they resolve asynchronously from their exact owners,
including lazy modules, at dispatch. Definitions sharing a name must share a schema.

`dispatcher.emit(event, input)` validates once and runs all matching listeners in
one fresh managed invocation. Schema failures occur before listener construction.
`dispatcher.inScope(container)` binds an existing same-application managed scope:
`emit(event,input)` and `emitUnknown(event,unknown)` validate before dispatch;
`defer(event,input)` queues delivery for managed completion. For HTTP, obtain the
child with `getRequestContainer(context)` and let HTTP finish it. Elsewhere create
an execution scope and await `finish()`. Closed, foreign and unmanaged scopes reject.
Await immediate emits; do not mutate deferred payloads before completion.

All listeners settle before rejection. One failure is rethrown; multiple failures
form an `AggregateError`. Deferred delivery retains scoped resources and rejects
completion when it fails. Fresh invocations do not inherit HTTP/tenant authority.

## Standalone callbacks

`EventEmitter` offers `on`, `once`, `off`, `emit`, `removeAllListeners` and
`listenerCount`. Register callbacks explicitly with `on(name, callback)`; decorated
listeners use `EventDispatcher`. Dot-separated names support `*` for one segment
and `**` for any depth. `emit` snapshots and settles all matching callbacks, with
exact handlers before wildcard groups in error ordering. There is no settlement
mode option. `once` is consumed before invocation, even with recursion, concurrent
emissions or failure; `off` accepts the original callback.

Local events, deferred work and CRUD `afterCommit` notifications are not a durable
outbox. Keep standalone event-source replay/notifier contracts separate.
