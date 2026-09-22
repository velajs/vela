# Dependency injection ownership

Declare dependencies with constructor injection or `defineProvider(token, { inject, useFactory })`.
Factory parameters are inferred from their tokens; the result must satisfy the provided token.
An `InjectionToken<T>` represents an identity, so two tokens with the same description remain distinct.

Each module owns its provider registrations. A token registered in two module instances has two
independent instances, including with `Scope.REQUEST`. Within a request child, repeated resolutions
of the same registration share a value; resolutions from another module's registration remain separate.
Concurrent `resolveAsync` calls share construction only for the same singleton or request registration.
Provider replacement creates a new registration and does not reuse the previous request value.

Declare a class's scope once, with `@Injectable({ scope })` or `@Controller({ path, scope })`. Class
decorators given no scope, such as `@Controller('/path')` or `@WebSocketGateway()`, never override a
declared scope, so decorator order does not matter. Two different scopes on one class throw when the
class is decorated.

A class provider keeps the scope its class declares, whether it is listed directly or registered
through `useClass`, including `APP_*` providers and exception handler classes. A `scope` set on the
provider overrides the class declaration. Value and factory providers default to `Scope.SINGLETON`.

`setRequestInstance(token, value)` explicitly seeds a value in one container. It overrides constructed
request values for that token, including an intentional `undefined`. The seed still requires a visible
request-scoped registration and cannot expose a private provider or create a missing provider.
Framework integrations register a globally visible request provider at bootstrap and seed it in each
request child. Seeds and `useValue` objects belong to their caller.

For diagnostics and discovery, `getProviderScope(token, moduleId)`, `isLazyPending(token, moduleId)`
and `isInstantiated(token, moduleId)` inspect that exact declaring module without constructing a
provider. They do not follow imports or global fallback. Omitting `moduleId` retains their token-wide
behavior. Resolve using `resolve(token, moduleId)` or `resolveAsync(token, moduleId)` to apply the
requesting module's visibility rules.

`getVisibleProviderSnapshots(token, requestingModuleId?)` inspects the same candidate registrations as
`resolveAll`, including their declaring module, effective scope, provider kind, class/alias wiring and
any value already available in that container. It never invokes a factory, constructs a request provider
or materializes a lazy module. The returned array, snapshots and instance cells are frozen; application
values are referenced as `unknown` and remain under application control. Factories and dependency
arrays are not exposed. Use this for startup wiring audits; a missing instance is not permission to
assume an opaque factory's output type or to construct it during the audit.

Circular dependencies through `useExisting` produce a circular-dependency error on both synchronous
and asynchronous resolution. Separate registrations sharing a token do not constitute a cycle.
An alias must be visible to its consumer, then its target resolves from the alias's declaring module.
An exported public alias can therefore expose its own module's private implementation without making
the implementation token public. An alias cannot access another module's unexported provider, and a
consumer's same-token provider cannot change the alias's declared target. The target determines the
instance lifetime; an alias does not independently cache a transient target.

## Resource lifetime

The container disposes constructed resources in reverse creation order. It prefers
`Symbol.asyncDispose`, then `Symbol.dispose`, then a `dispose()` method. Errors from one disposer
are logged according to the container's diagnostics setting and do not skip other resources.

- Singleton instances and the transient dependencies constructed for them belong to the application
  root, even if a request first resolves that graph.
- Request-scoped instances and their transient dependencies belong to the request child. A transient
  resolved directly from a child also belongs to that child. Each transient resolution still creates a
  fresh instance.
- Values registered with `useValue` and explicit request seeds remain caller-owned. A factory returning
  an already-owned dependency does not transfer ownership or arrange a second disposal.

```ts
const child = container.createChild();
try {
  const operation = await child.resolveAsync(OPERATION, moduleId);
  await operation.run();
} finally {
  await child.dispose();
}
```

`dispose()` waits for construction already owned by that container, including transient factories and
dependencies still completing after a sibling fails. Concurrent disposal calls share the same teardown.
`hasDisposables()` also reports pending owned construction because it may produce resources later.
New resolutions during teardown fail; factories must settle for disposal to complete. Framework
invocation scopes should drain managed work and finish streaming before disposing the child.

For 1.x compatibility, the container can be reused after `await dispose()`: registrations remain, cached
constructed values and request seeds are cleared, and new resolution constructs a fresh graph.
`dispose()` does not permanently close an invocation; adapters must enforce that lifetime themselves.
Root disposal is not a substitute for finishing/disposal of every active request child. `clear()` is a
registration reset rather than resource teardown; dispose resources before clearing a container.

Container caches and ownership state use JavaScript `#private` fields. Use the public diagnostic and
resolution methods instead of inspecting mutable internals. Constructor-injected classes can also use
`#private` fields; circular `forwardRef` proxies preserve private method and getter receivers.
