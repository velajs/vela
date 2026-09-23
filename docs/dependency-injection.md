# Dependency injection ownership

Declare dependencies with constructor injection or `defineProvider(token, { inject, useFactory })`.
Factory parameters are inferred from their tokens; the result must satisfy the provided token.
An `InjectionToken<T>` represents an identity, so two tokens with the same description remain distinct.

## Providers

A module's `providers` accepts classes, `defineProvider()` definitions and Nest's provider
literals:

```ts
@Module({
  providers: [
    UsersService,
    { provide: CLOCK, useValue: systemClock },
    { provide: Storage, useClass: MemoryStorage },
    { provide: STORE, useExisting: Storage },
    { provide: STARTED_AT, useFactory: () => Date.now() },
    { provide: APP_GUARD, useClass: RolesGuard },
    defineProvider(REPORTS, { inject: [UsersService, CLOCK], useFactory: (users, clock) => ... }),
  ],
})
class UsersModule {}
```

`@Module` checks each literal against its token: `useValue`, `useClass`, `useExisting` and the
factory's result must produce the token's value type, so `{ provide: COUNT, useValue: 'one' }` does
not compile for an `InjectionToken<number>`. A literal factory takes no parameters. A factory with
dependencies uses `defineProvider`, which infers its parameters from `inject`.

A factory without parameters may omit `inject`, in `defineProvider`, `lazyProvider`, literals and
`forRootAsync` options alike. A factory that declares parameters without `inject` throws when it is
defined, naming the token, because its parameters would otherwise receive `undefined`.

A `DynamicModule` and `defineModule`'s `setup` contributions are object literals the compiler cannot
correlate per element, so they accept the loosely typed `ProviderLiteral` union. The module loader
checks each literal when the module loads: an entry without a token, without exactly one of
`useValue`, `useClass`, `useFactory` and `useExisting`, or with a strategy of the wrong kind fails
the load with an error naming the list entry and its token, for example
`FeatureModule.providers[2] (InjectionToken(STORE)) is not a provider`. Prefer `defineProvider` in
computed contributions when the value type matters.

Every application provides `Reflector` globally, so guards and interceptors inject it through their
constructor, as in Nest.

## Module classes and enhancers

A module class is a provider of its own module. The container constructs it through DI after the
module's providers, and it receives the same lifecycle hooks, in the same phases, after those
providers. A lazy module's class is built with the rest of its group. `configure()` runs on that
same instance.

Guard, pipe, interceptor and filter classes that a module's classes reference in `@UseGuards`,
`@UsePipes`, `@UseInterceptors`, `@UseFilters` or parameter decorators such as
`@Param('id', ParseIntPipe)` need no `providers` entry. The module loader scans the module class,
its class providers (including `useClass` targets) and its controllers, so gateways, processors,
live resolvers and other entrypoint classes are covered too. It registers each referenced class in
the declaring module unless one is already visible there, such as a provider exported by an
imported module. The class then resolves like any provider of that module: its dependencies come
from the declaring module, a singleton is built once instead of per request, a request-scoped
enhancer (declared, or bubbled from a request-scoped dependency) is built per request, and an
enhancer of a lazy module waits for its group. A referenced class with no class decorator has no
metadata to inject; it is built with `new`, once per scope, without the missing-decorator
diagnostic. Classes passed to `app.useGlobalGuards()` and the other `useGlobal*` methods are not
scanned: one without constructor dependencies is still built with `new` on each use.

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
provider overrides the class declaration. Value and factory providers default to `Scope.DEFAULT`.

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

`@Optional()` injects `undefined` only when no module registers the token. When another module
registers it without exporting it to the consumer, the wiring mistake is reported through the
container's diagnostics policy: `throw` fails construction with `ModuleVisibilityError`, `log` warns
once per consuming module and injects `undefined`, and `silent` injects `undefined`. An
`InjectionToken` with a default factory still resolves through that factory.

Circular dependencies through `useExisting` produce a circular-dependency error on both synchronous
and asynchronous resolution. Separate registrations sharing a token do not constitute a cycle.
An alias must be visible to its consumer, then its target resolves from the alias's declaring module.
An exported public alias can therefore expose its own module's private implementation without making
the implementation token public. An alias cannot access another module's unexported provider, and a
consumer's same-token provider cannot change the alias's declared target. The target determines the
instance lifetime; an alias does not independently cache a transient target.

## Constructor metadata

Constructor injection reads the `design:paramtypes` metadata that TypeScript, SWC and Oxc emit
for a decorated class when `emitDecoratorMetadata` is enabled, plus any `@Inject(token)` and
`@Optional()` entries. The container plans each class provider's parameters once, when the class
is registered. For a class with a class decorator or `@Inject`/`@Optional` entries, it throws
`MissingInjectionMetadataError` before anything constructs it when a parameter has no usable token:

- the build emitted no paramtype for it (the constructor declares more parameters than the
  metadata and `@Inject` indexes cover), or
- its paramtype is `Object` or `undefined` (an interface, a type-only import, or a circular import)
  and it has no `@Inject(token)`.

The error names the class and the parameter index. Enable `emitDecoratorMetadata`, add
`@Inject(Token)` to that parameter, or mark it `@Optional()` to inject `undefined`. A
`forwardRef` token is accepted as declared and resolved later. A subclass without its own
constructor inherits its parent's metadata; a subclass that declares a constructor uses its own.

A class with no class decorator at all, such as a third-party client or a hand-written test fake,
never had metadata to emit. Like Nest, the container constructs it with no arguments, so
`{ provide: EVENTS, useClass: EventEmitter }` keeps working. When such a class declares
constructor parameters, they stay `undefined`: the container reports it through its diagnostics
policy (`'log'` warns, `'throw'` fails bootstrap, `'silent'` ignores it) with a message naming the
missing class decorator. Decorate the class with `@Injectable()`, or provide a class you do not own
with `useFactory`. Registering an undecorated class directly in `providers` is reported the same
way, as is a module export that is neither a local provider nor exported by an imported module.
Any Vela class decorator implies `@Injectable()`: `@Module`, `@Controller`, `@Catch`, gateway,
seeder and discoverable class decorators such as `@Processor` and `@LiveResolver` all count as
decorated, so none of them needs a stacked `@Injectable()`. Stack `@Injectable({ scope })` only to
declare a scope; a class decorator never overrides one.

## Unresolved dependencies

When a class constructor argument has no provider visible to the module that resolves the class,
construction fails with `UnresolvedDependencyError`. The message names the class, its module, the
argument and the reason:

```text
Cannot resolve UsersController(?, AuditService) in UsersModule. Argument #0 UsersService is declared in DataModule but not exported (add it to DataModule.exports).
```

The reason is one of three cases, also available as `error.reason.kind`:

- `'not-exported'`: the listed modules declare the token, but none exports it.
- `'not-imported'`: the listed modules export it, but the resolving module imports none of them.
- `'not-provided'`: no module declares it (`is not provided in UsersModule or its imports`).

`error.reason.modules` holds module instance ids. `className`, `moduleId`, `parameterIndex` and
`token` identify the argument, and `cause` keeps the lookup failure (a `ModuleVisibilityError`
when the token exists elsewhere). Only the innermost constructor reports: when `Facade` needs
`Repository` and `Repository` cannot resolve `UsersService`, the error names `Repository`. Provider
factories (`useFactory` + `inject`), aliases (`useExisting`) and `forwardRef` proxies resolved
after a cycle keep their own lookup errors.

## Request-scoped providers and the root container

A request-scoped provider, including one that is request-scoped because it depends on one, never
resolves on the root container: its instance would outlive its request and leak into later ones.
`container.resolve`, `container.resolveAsync` and `app.get` throw for it on the root. Resolve it in
the execution scope that owns the invocation: `getRequestContainer(c)`, `context.getContainer()` or
the `runInEntrypointScope` callback argument. Discovery resolves request-scoped hits only when the
caller passes `{ requestScope: scope }`.

Inside a provider, `await moduleRef.resolve(token, context)` resolves in the scope that `context`
identifies; see [ModuleRef](#moduleref). In tests, `TestingModule.get` throws for request-scoped
providers too; use `await module.resolveInRequest(token)`.

## ModuleRef

Inject `ModuleRef` to look providers up from the point of view of the module that injects it. The
container builds one per module and owner: a singleton receives one owned by the application root,
and a request-scoped consumer receives one bound to its own request, which closes with that request.
A singleton never captures a request.

- `get(token, { strict })` returns a singleton or value provider. By default (`strict: true`) it sees
  what the host module can inject: its own providers, its imports' exports and global tokens. This is
  more lenient than Nest's strict `get`, which searches only the host module's own providers.
  `{ strict: false }` looks the token up across the application. `get` throws for request-scoped
  and transient providers, since neither has a single instance to return.
- `await resolve(token, context?, { strict })` resolves any provider and awaits async factories.
  `context` identifies an existing execution scope: the `ExecutionContext` of a guard or
  interceptor, the Hono `Context` of a Vela-managed request, or an execution-scope container.
  Request-scoped providers resolve to the instance that request's other consumers receive. Without
  a context, `resolve` uses the scope that owns the reference, so a request consumer's reference
  resolves in its request and a singleton's reference refuses request-scoped tokens. `resolve`
  never creates a request scope, because a scope owns request disposables that someone must finish.
  A transient provider is constructed on each call.
- `await create(Type)` constructs a class that is not registered as a provider, injecting what the
  host module can see. Each call returns a new instance that the caller owns.

```ts
@Injectable()
class SessionGuard implements CanActivate {
  constructor(private readonly moduleRef: ModuleRef) {}

  async canActivate(context: ExecutionContext) {
    const session = await this.moduleRef.resolve(SessionState, context);
    return session.isActive;
  }
}
```

`app.get(ModuleRef)` returns the application-wide reference, whose lookups are not limited to one
module.

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
