---
'@velajs/vela': minor
---

Providers and enhancers are authored as in Nest:

- `@Module({ providers })` accepts `{ provide, useValue | useClass | useExisting | useFactory }` literals, including `APP_*` tokens. Each literal is checked against its token, so a value, class, alias or factory result of the wrong type does not compile. A literal factory takes no parameters; a factory with dependencies keeps using `defineProvider`, which infers them from `inject`. `DynamicModule.providers` and `defineModule` `setup` contributions accept the loosely typed `ProviderLiteral` union, and the module loader checks each literal when the module loads: an entry that is not a provider fails with an error naming the list entry and its token. Adds the `Provider`, `ProviderLiteral`, `TypedProviderLiteral`, `CheckedProviders`, `FactoryInject` and `ModuleDecoratorOptions` types.
- A factory without parameters may omit `inject` in `defineProvider`, `lazyProvider`, literals and `forRootAsync` options.
- Every application provides `Reflector` globally, so guards and interceptors inject it instead of calling `new Reflector()`.
- Any Vela class decorator implies `@Injectable()`: discoverable class decorators such as `@Processor` and `@LiveResolver`, and `@Catch`, mark the class injectable without changing a declared scope.
- Guard, pipe, interceptor and filter classes referenced by `@UseGuards`, `@UsePipes`, `@UseInterceptors`, `@UseFilters` or parameter decorators on a module's class, class providers or controllers (gateways, processors, live resolvers and other entrypoint classes included) need no `providers` entry.
- `exports: [ImportedModule]` re-exports everything the imported module exports.
- Module classes are constructed through DI and receive lifecycle hooks.

**Behavior change:**

- Referenced enhancer classes are registered in the declaring module unless one is already visible there, and resolve through the container from that module. A singleton enhancer is now built once, at bootstrap (or with its lazy module), and receives lifecycle hooks, instead of being built with `new` on every request; a request-scoped one, declared or bubbled, is built per request. An enhancer whose dependencies the declaring module cannot see now fails bootstrap with `UnresolvedDependencyError` instead of failing each request, and one registered but not exported by another module gets its own instance instead of a `ModuleVisibilityError`. A referenced class with no class decorator is still built with `new`, once per scope. Classes passed to `app.useGlobalGuards()` and the other `useGlobal*` methods are unchanged.
- The module class is registered in its own module after the module's providers and constructed at bootstrap (or with its lazy group), and receives `onModuleInit`, `onApplicationBootstrap` and the shutdown hooks after them. It now appears among its module's providers in `getModuleDescriptions()` and to `DiscoveryService`, and `app.get(ModuleClass)` returns it. A module class whose constructor dependencies are not visible now fails bootstrap.
- `exports: [ImportedModule]` no longer reports an unknown export: it expands to the imported module's exports, and a dynamic module is re-exported by its class. Re-exporting a module whose exports a `forwardRef` import cycle leaves unknown throws; export its tokens directly.
- A factory that declares parameters but has no `inject` now throws when it is defined, naming its token, instead of running with `undefined` arguments.
- `DynamicModule.providers` and `ModuleContributions.providers` are typed `Provider[]`, and `ModuleOptions.providers` and `ModuleMetadata.providers` are `readonly Provider[]`: their entries may be literals, which `Container.register()` does not accept; register a `DynamicModule` through a module import instead. `AsyncModuleOptions` and `LazyProviderSpec` are now type aliases instead of interfaces, so an interface can no longer extend them: intersect instead (`AsyncModuleOptions<T, Inject> & { name: string }`).
- `CacheInterceptor`, `ResponseCacheInterceptor` and `ThrottlerGuard` take the injected `Reflector` as their last constructor parameter; a subclass that declares its own constructor passes it to `super()`.
- `isInjectable()` returns `true` for classes decorated with a discoverable class decorator or `@Catch`.
