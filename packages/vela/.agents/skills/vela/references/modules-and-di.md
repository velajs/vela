# Modules & Dependency Injection

Vela's DI is NestJS-compatible: decorator metadata drives constructor injection, providers live in modules, and visibility follows imports/exports. All on `@velajs/vela`.

## Modules

```ts
import { Module } from '@velajs/vela';

@Module({
  imports: [OtherModule],       // modules whose exports you need
  controllers: [UserController],
  providers: [UserService, { provide: TOKEN, useValue: cfg }],
  exports: [UserService],       // what importers of THIS module can resolve
})
class UserModule {}
```

`ModuleOptions`: `imports`, `controllers`, `providers`, `exports`, `lazy?`. `lazy: true` defers the whole module to first use — see `lazy-and-lifecycle.md`.

`global` lives in two places only: `@Global()` on a module class, and `global: true` on one `DynamicModule` instance (the `isGlobal` extra of `forRoot`/`forRootAsync` sets it). `@Module` has no global option. Only **exported** tokens become app-wide.

Modules are static. Declare every module, controller and provider class once at module scope, and never decorate a class inside a function: each call would declare new classes, and the isolate-global metadata registry keeps them all. The application root is a module class or a `DynamicModule` (`AppModule.forRoot(...)`) declared the same way, and any module can inject it as the global `ROOT_MODULE`. Runtime values (bindings, secrets, per-environment clients) enter through DI: `forRootAsync({ inject: [ENV], useFactory })`, `useFactory` providers, `@InjectEnv()`, or an injectable class a decorator names (such as a gateway's `authenticator`). Those run per application, so several applications, including one per Workers environment, share the classes but no instances.

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

Provider kinds, as Nest literals in `@Module({ providers })` or through `defineProvider`:

```ts
{ provide: TOKEN, useValue: instance }
{ provide: TOKEN, useClass: Impl }
{ provide: ALIAS, useExisting: TOKEN }          // same instance under a second token
{ provide: TOKEN, useFactory: () => build() }   // a literal factory takes no parameters
defineProvider(TOKEN, { useFactory: (dep) => build(dep), inject: [DEP_TOKEN] })
ProductService // class-provider shorthand
```

`@Module` checks each literal against its token: `{ provide: COUNT, useValue: 'one' }` does not compile for an `InjectionToken<number>`. A factory with dependencies uses `defineProvider` (import it from `@velajs/vela`), which infers its parameters from `inject`; do not spread a definition to modify its registration. `inject` may be omitted only when the factory takes no parameters (`defineProvider`, `lazyProvider` from `@velajs/vela/module-kit`, literals, `forRootAsync`); a factory with parameters and no `inject` throws, naming the token. `DynamicModule.providers` and `defineModule` `setup` contributions accept loosely typed literals that the loader checks when the module loads (an entry that is not a provider fails, naming the entry and its token).

Every application provides `Reflector` globally: inject it (`constructor(private readonly reflector: Reflector) {}`) instead of `new Reflector()`.

Any Vela class decorator implies `@Injectable()` (`@Controller`, `@Catch`, `@WebSocketGateway`, `@Seeder`, `@Processor`, `@LiveResolver` and other discoverable decorators); stack `@Injectable({ scope })` only to set a scope. A class with no class decorator has no constructor metadata and is reported through `diagnostics` when registered.

Module classes are providers of their own module: constructed through DI after its providers, they receive the same lifecycle hooks after them, and `configure()` runs on that instance.

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

A provider is private to its declaring module unless listed in that module's `exports`. Importers then resolve it. Re-export works transitively: import a module and list its token, or the module itself (`exports: [DatabaseModule]`, which re-exports everything that module exports; a dynamic module is named by its class), in your own `exports`. Re-exporting a module whose exports a `forwardRef` cycle leaves unknown throws; export its tokens directly. A constructor argument without a visible provider throws `UnresolvedDependencyError` naming the class, module, argument and fix (`Cannot resolve UsersController(?, AuditService) in UsersModule. Argument #0 UsersService is declared in DataModule but not exported (add it to DataModule.exports)`), with the `ModuleVisibilityError` as `cause`; direct `resolve()` calls and factory `inject` lists throw `ModuleVisibilityError` itself. Importing two instances that export the same token throws `MultipleProvidersFoundError` (see `SKILL.md` Troubleshooting), also when one of them is a `@Global()` module imported explicitly. A module resolves a token from its own providers first, then its imports' exports, then the one `@Global()` module that exports it, then the application's registration (`Reflector`, `ENV`, `NONCE_STORE`, ...) or an `InjectionToken` default factory, which applies only when no module registers the token (a registration the module cannot see throws `ModuleVisibilityError`); `resolveAll(token, moduleId)` returns the providers of that same step. Application-wide lookups (`app.get`, `ModuleRef.get(token, { strict: false })`, dependencies of framework services such as `SignedInvocationGuard`) take what the application configures itself first (the `env` option, an adapter's `configureContainer`, `app.useGlobalExceptionHandler()`, testing overrides), then the one `@Global()` exporter, then the framework default (`MemoryNonceStore`, `Reflector`, ...), so a `@Global()` module exporting `NONCE_STORE` overrides the framework default everywhere. A `NONCE_STORE` or `ENV` the application configures itself still wins application-wide, while modules keep resolving the `@Global()` export.

## Dynamic modules — `forRoot` / `forRootAsync`

Every first-party configurable module exposes `forRoot(options)` (sync) and `forRootAsync({ useFactory, inject, imports })` (DI-resolved). A module's **structural** options (those that shape its graph, such as a bucket `name` or an `http` mount) go next to the factory; the factory returns the rest:

```ts
@Module({
  imports: [
    CacheModule.forRoot({ namespace: 'catalog-v1', scope: trustedCacheScope, ttl: 60 }),
    ConfigModule.forRootAsync({
      inject: [SecretLoader],
      useFactory: async (loader: SecretLoader) => ({ config: await loader.load() }),
    }),
    StorageModule.forRootAsync({
      name: 'uploads',                                   // structural: at the call site
      inject: [ENV],
      useFactory: (env) => ({ driver: () => r2Driver({ bucket: env.UPLOADS }) }),
    }),
    RegionModule.forRootAsync({ useFactory: () => ({ region: 'eu' }) }), // no parameters: no inject
  ],
})
class AppModule {}
```

The instance key comes from the structural options only, so most modules have one instance per class: the same configuration imported twice deduplicates, while a second configuration under the same key fails bootstrap in every diagnostics mode, even when its `isGlobal` differs too. A repeat with the same options and only another `isGlobal` is reported (`'log'` warns, `'throw'` fails bootstrap) and the first is kept. An extra at its default, a structural option at the module's default (`globalGuard: true`) or an option passed as `undefined` (at any depth) counts as not given. A bare class import configures nothing: a configured import under its key (`HttpModule.forRoot({ key: 'default', baseURL })` next to `HttpModule`) fails bootstrap in either order. Give a second instance its own `key` (`MailModule.forRoot({ ..., key: 'marketing' })`). `key`, `lazy` and `isGlobal` never change the key or reach the options token. `isGlobal` only makes exports visible everywhere; options that register app-wide components are named for them (`FeatureFlagsModule`'s `globalGuard`, and `guard: 'global' | 'none'` on `BetterAuthModule`, `CloudflareAccessModule`, `TenantModule`, `AuthzModule` and `CedarModule`).

## Authoring a configurable module — `defineModule`

`defineModule` is THE module-authoring engine: one spec generates `forRoot` **and** `forRootAsync`, the instance key, and contributions computed from the structural options:

```ts
import { defineModule, defineProvider, InjectionToken } from '@velajs/vela';

const STORAGE_OPTIONS = new InjectionToken<StorageOptions>('STORAGE_OPTIONS');

const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = defineModule<StorageOptions, 'http'>({
  name: 'Storage',
  optionsToken: STORAGE_OPTIONS,
  structural: ['http'],                    // setup/key see only these; the async factory returns the rest
  setup: ({ OPTIONS, options }) => ({
    providers: [defineProvider(DRIVER, { useFactory: (o) => o.driver(), inject: [OPTIONS] })],
    controllers: options.http ? [StorageController] : [],
    exports: [DRIVER],
    global: { guards: [StorageGuard] },   // app-wide APP_* wiring, one idiom
  }),
});
export class StorageModule extends ConfigurableModuleClass {}
```

`defaults: { ... }` gives structural options the values a call site may leave out, so spelling out a default keys and compares like leaving it out. `key: (options) => ...` overrides the default key (`stableHash` of the structural options over `defaults`); `referenceKey(...values)` from `@velajs/vela/module-kit` keys stateful values by reference. `ConfigurableModuleBuilder` is the NestJS-shaped facade over the same engine: it generates Nest's `register`/`registerAsync` (rename with `setClassMethodName('forRoot')`); retain the returned builder from each configuration step. For the full authoring contract (structural options, keys, `lazyProvider`, `sideEffectModule`, discovery, entrypoints, route contributors), read the repo's `docs/modules.md`.
