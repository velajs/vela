# Execution scopes and managed work

An invocation owns a child DI container. HTTP requests create one child, while
queue processors, scheduled handlers, and other adapters can use
`runInEntrypointScope`. Application singletons remain owned by the application;
request-scoped providers and their consumers resolve within the child.

```ts
import { EXECUTION_LIFETIME, Inject, Injectable, type ExecutionLifetime } from '@velajs/vela';
import { runInEntrypointScope } from '@velajs/vela/module-kit';

@Injectable()
class Handler {
  constructor(@Inject(EXECUTION_LIFETIME) private readonly lifetime: ExecutionLifetime) {}

  async process() {
    this.lifetime.defer(async () => {
      // Runs when the invocation handler settles. Request-scoped dependencies
      // remain available until this managed work and its nested work finish.
      await sendMetrics();
    });
  }
}

await runInEntrypointScope(app.getContainer(), async (scope, lifetime) => {
  const handler = await scope.resolveAsync(Handler, ownerModuleId);
  await handler.process();
  lifetime.waitUntil(alreadyStartedWork);
});
```

`defer(callback)` starts the callback during invocation completion. `waitUntil`
registers an already-started promise and immediately observes its rejection.
Both keep the child alive. Deferred callbacks execute in registration order;
work they register is drained as well. Every task settles before disposal, even
when a task rejects. One completion error is rethrown unchanged; multiple errors
are an `AggregateError`. A handler failure and a completion failure are both
retained. Callers must observe the returned promise.

`ExecutionLifetime.id` is a generated correlation identifier, and `startedAt` is
a Unix timestamp in milliseconds. Neither carries authenticated identity.
`signal` is an optional cooperative cancellation signal supplied by the adapter.
Aborting it does not dispose resources still in use. `active` becomes false
before disposal; registering more work after closure throws.

`REQUEST_CONTEXT` remains an HTTP primitive. Non-HTTP scopes do not manufacture
requests or inherit trusted principal/tenant authority. A trusted transport may
explicitly establish its own operation context through the relevant integration.
These helpers do not enable ambient context storage. Ambient accessors remain
an HTTP read path: starting a nested non-HTTP invocation does not switch the
inherited HTTP ambient context. Pass the invocation's child container explicitly.
The existing package root still loads Hono's context-storage module, so disabling
ambient reads does not remove that module's runtime ALS requirement.

## Custom transport integration

`createExecutionScope(root, { signal })` returns `{ container, lifetime, finish }`.
Resolve a declared entrypoint with `resolveEntrypoint(container, entrypoint)`;
it uses `entrypoint.moduleId` and asynchronous DI. Legacy entries that omit the
owner are accepted only when the registered token has a unique owner. Unknown
owners and ambiguous omissions fail before dispatch.

Custom adapters can construct pipeline contexts inside that child using
`buildEntrypointExecutionContext(kind, token, method, payload, moduleId, container)`.
Use `resolveScopedComponentsAsync(kind, token, method, container, moduleId)`
for handler-declared components (including the owning module's `@Use*`
components for its controllers) and `resolvePipelineComponents(kind, entries,
container)` for explicit application-global lists. They preserve order, typed
provider inference, and asynchronous factory/lazy-module resolution. Reverse
filters when applying the closest-first convention. Decide explicitly which
global or handler-scoped pipeline components apply. HTTP-backed optional
adapters can use `buildHttpExecutionContext` with the original Hono context and
child container instead of manufacturing a second HTTP request.
Call `finish()` on both success and failure, or use `runInEntrypointScope` to own
that lifecycle automatically. An injected lifetime requires the framework's
request-scoped `EXECUTION_LIFETIME` provider; bare custom containers must register
that token with a request-scoped provider before injection.

For streaming transports, `finish(bodyDone)` starts draining work immediately
but waits for the supplied boundary too. Resolve `bodyDone` when the response
stream finishes, errors, or is canceled. Work registered while that boundary
is open is also drained. The first `finish` call selects the boundary, and all
subsequent calls return the same completion promise. HTTP adapters must keep
native upgrade responses intact and register asynchronous finalization with the
platform's background-work mechanism when it outlives response handling.

`getExecutionLifetime(container)` returns undefined for unmanaged or closed
children. `finishExecutionScope(container, bodyDone)` lets adapters finalize a
child they recovered from an existing request association. Retaining a raw
Container does not grant permission to reuse a closed invocation; Container's
legacy reuse semantics are separate from the lifetime capability.
