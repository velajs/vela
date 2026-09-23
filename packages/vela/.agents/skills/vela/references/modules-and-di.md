# Modules & Dependency Injection

Vela's DI is NestJS-compatible: decorator metadata drives constructor injection, providers live in modules, and visibility follows imports/exports. All on `@velajs/vela`.

## Modules

```ts
import { Module, defineProvider } from '@velajs/vela';

@Module({
  imports: [OtherModule],       // modules whose exports you need
  controllers: [UserController],
  providers: [UserService, defineProvider(TOKEN, { useValue: cfg })],
  exports: [UserService],       // what importers of THIS module can resolve
})
class UserModule {}
```

`ModuleOptions`: `imports`, `controllers`, `providers`, `exports`, `isGlobal?`, `lazy?`. `@Global()` sets `isGlobal` (only **exported** tokens become app-wide). `lazy: true` defers the whole module to first use — see `lazy-and-lifecycle.md`.

> Field-name gotcha: it is `isGlobal` on `@Module`/`ModuleOptions`, but `global` on a `DynamicModule` object.

## Providers & injection

Class-type constructor params auto-resolve via emitted decorator metadata — no `@Inject` needed. Use `@Inject(token)` only for non-class tokens (`InjectionToken`, string, symbol), `forwardRef`, or when a bundler strips types:

```ts
@Injectable()
class ProductService {
  constructor(
    private readonly config: ConfigService,          // class → auto-resolved
    @Inject(PRODUCT_STORE) private readonly store: ProductStore,   // token → @Inject
    @Optional() @Inject(OPTIONAL_LABEL) private readonly label?: string,
  ) {}
}
```

Provider kinds:

```ts
defineProvider(TOKEN, { useValue: instance })
defineProvider(TOKEN, { useClass: Impl })
defineProvider(TOKEN, { useFactory: (dep) => build(dep), inject: [DEP_TOKEN] })
defineProvider(ALIAS, { useExisting: TOKEN })   // same instance under a second token
ProductService // class-provider shorthand
```

Import `defineProvider` from `@velajs/vela`. Descriptors are checked before entering heterogeneous module arrays; do not replace them with raw objects or spread them to modify their registration. Factory `inject` is mandatory, including `[]` for zero dependencies.

Tokens: mint with `new InjectionToken<T>('NAME')` (optionally `{ factory: () => default }` to self-provide when unregistered).

`InjectionToken<Value>` is invariant. `Token` denotes erased runtime identity; `TypedToken<Value>` denotes a typed authoring token. Resolution infers from the actual class/token; raw string/symbol reads return unknown. Do not select a result generic or widen a typed token to authorize an incompatible provider.

## Scopes

`Scope` is a const object with `DEFAULT` (a singleton, Nest's default), `REQUEST`, and `TRANSIENT`:

```ts
@Injectable({ scope: Scope.REQUEST })
class RequestMarker { readonly id = crypto.randomUUID(); }
```

Declare a class's scope once, with `@Injectable({ scope })` or `@Controller({ path, scope })`; decorator order does not matter, a decorator given no scope never overrides one, and two different scopes on one class throw.

A `useClass` provider (including `APP_*` providers) inherits the scope its class declares; set `scope` on the provider to override it: `defineProvider(TOKEN, { useClass: Impl, scope: Scope.DEFAULT })`.

**Request-scope bubbling:** any singleton that transitively depends on a request-scoped provider is automatically rebuilt per request (its effective scope becomes REQUEST). Each HTTP request gets a child container; request-scoped instances live there and are disposed at request end. Inject `REQUEST_CONTEXT` to read/write per-request state. Use `new RequestContextKey<Value>(description)` with `context.set(key, value)` / `context.get(key)`; raw string/symbol reads return unknown.

Request-scoped providers (declared or bubbled) never resolve on the root container: `container.resolve`, `container.resolveAsync` and `app.get` throw with guidance. Resolve them in the invocation's container (`getRequestContainer(c)`, `context.getContainer()`, the `runInEntrypointScope` callback argument). Discovery resolves request-scoped hits only with `{ requestScope: scope }`.

Constructed request instances are keyed by provider registration, so the same token in two module buckets resolves independently. Explicit `setRequestInstance(token, value)` seeds remain token-wide within the child and require a visible request-scoped registration; they do not create providers or bypass visibility. Retain `moduleId` from registration-oriented discovery instead of choosing `moduleIds[0]`. See `invocation-scopes.md` for dispatch and cleanup.

## `@Inject`, `@Optional`, `forwardRef`

`@Optional()` injects `undefined` only when no module registers the token. A token another module registers without exporting it to the consumer is reported through `diagnostics` (`throw`: `ModuleVisibilityError`; `log`: one warning per module, then `undefined`; `silent`: `undefined`). An `InjectionToken` default factory still supplies its value.

Circular dependencies (provider↔provider or module↔module) resolve with `forwardRef`:

```ts
@Injectable()
class AlphaService {
  constructor(@Inject(forwardRef(() => BetaService)) private readonly beta: BetaService) {}
}

@Module({ imports: [forwardRef(() => ModuleA)] /* ... */ })
class ModuleB {}
```

## `ModuleRef` — imperative resolution

```ts
@Injectable()
class Playground {
  constructor(private readonly moduleRef: ModuleRef) {}
  async run(context: ExecutionContext) {
    const singleton = this.moduleRef.get(CounterService);                    // singleton/value, host-module visibility
    const anywhere = this.moduleRef.get(CounterService, { strict: false });   // app-wide lookup
    const session = await this.moduleRef.resolve(SessionState, context);      // request-scoped: this request's instance
    const fresh = await this.moduleRef.create(SandboxTool);                   // unregistered class, host-module deps
  }
}
```

Each module gets its own `ModuleRef`: a singleton's is owned by the root, a request-scoped consumer's is bound to its request (and closes with it); a singleton never captures a request. `get` sees the host module's providers, its imports' exports and globals (more lenient than Nest's strict `get`, which only searches the host module) and throws for request-scoped/transient tokens. `resolve(token, context?)` takes an `ExecutionContext`, a Hono `Context` of a Vela-managed request, or an execution-scope `Container`; it never creates a request scope, so without one a root-owned reference refuses request-scoped tokens. `create(Type)` returns a new caller-owned instance per call.

## Visibility & exports

A provider is private to its declaring module unless listed in that module's `exports`. Importers then resolve it. Re-export works transitively (import a module and list its token in your own `exports`). A constructor argument without a visible provider throws `UnresolvedDependencyError` naming the class, module, argument and fix (`Cannot resolve UsersController(?, AuditService) in UsersModule. Argument #0 UsersService is declared in DataModule but not exported (add it to DataModule.exports)`), with the `ModuleVisibilityError` as `cause`; direct `resolve()` calls and factory `inject` lists throw `ModuleVisibilityError` itself. Importing two instances that export the same token throws `MultipleProvidersFoundError` (see `SKILL.md` Troubleshooting).

## Dynamic modules — `forRoot` / `forRootAsync`

Configurable modules expose `forRoot(options)` (sync) and `forRootAsync({ useFactory, inject, imports })` (DI-resolved):

```ts
@Module({
  imports: [
    CacheModule.forRoot({ ttl: 60 }),
    ConfigModule.forRootAsync({
      inject: [SecretLoader],
      useFactory: async (loader: SecretLoader) => ({ config: await loader.load() }),
    }),
  ],
})
class AppModule {}
```

Same options dedup (via a `stableHash(options)` key); distinct options coexist. For hand-rolled dynamic modules use `defineDynamicModule({ module, key, providers, exports })`.

## Authoring a configurable module — `defineModule`

`defineModule` is THE module-authoring engine: one spec generates `forRoot` **and** `forRootAsync`, a deterministic instance key, and options-derived contributions:

```ts
import { defineModule, defineProvider, InjectionToken } from '@velajs/vela';

const STORAGE_OPTIONS = new InjectionToken<StorageOptions>('STORAGE_OPTIONS');

const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = defineModule<StorageOptions>({
  name: 'Storage',
  optionsToken: STORAGE_OPTIONS,
  setup: ({ OPTIONS, options }) => ({
    providers: [defineProvider(DRIVER, { useFactory: (o) => o.driver(), inject: [OPTIONS] })],
    controllers: options.http ? [StorageController] : [],
    exports: [DRIVER],
    global: { guards: [StorageGuard] },   // app-wide APP_* wiring, one idiom
  }),
});
export class StorageModule extends ConfigurableModuleClass {}
```

`ConfigurableModuleBuilder` is an adapter over the same engine; retain the returned builder from each configuration step. Prefer the single-spec `defineModule` API for new modules. For the full authoring contract (keys, `lazyProvider`, `provideGlobal`, `sideEffectModule`, discovery, entrypoints, route contributors), read the repo's `docs/modules.md`.
