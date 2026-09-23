---
"@velajs/vela": minor
---

**Behavior change:** the container plans each class provider's constructor once, at registration, and throws the new `MissingInjectionMetadataError` before anything constructs it when a parameter has no usable token. That covers a constructor that declares more parameters than its `design:paramtypes` and `@Inject` indexes describe (a build without `emitDecoratorMetadata`), and a parameter whose paramtype is `Object` or `undefined` (an interface, a type-only import, or a circular import) without `@Inject(token)`. Previously the first case constructed the class with `undefined` injected fields, and the second failed only when the class was first resolved. `@Optional()` parameters still resolve to `undefined`, and `forwardRef` tokens are still evaluated at resolution. The error exposes `className`, `parameterIndex` and `reason`.

A subclass without its own constructor now inherits its parent's constructor metadata (`design:paramtypes` and `@Inject`/`@Optional` entries) instead of being constructed with no arguments. An unregistered guard, pipe, interceptor, filter or middleware class that inherits constructor dependencies this way now fails with the existing "Cannot instantiate" error instead of being constructed with `new` and no arguments.

**Behavior change:** registering a provider class that carries no class decorator, and exporting a token that is neither a local provider nor exported by an imported module, are now reported through the container's diagnostics policy: `'log'` warns (with a `[vela]` prefix), `'throw'` fails bootstrap and `'silent'` stays quiet. Both previously always called `console.warn`. `@Module` classes resolved for `configure()`, `@Catch` filters and classes with gateway or discoverable class decorators no longer trigger the missing-decorator warning.

`Reflector`, `SerializerInterceptor` and `ValidationPipe` are now `@Injectable()`, so `defineProvider(APP_PIPE, { useClass: ValidationPipe })` keeps working: its optional schema parameter is `@Optional()`.
