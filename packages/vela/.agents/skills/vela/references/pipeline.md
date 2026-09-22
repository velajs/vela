# Request Pipeline — Guards, Pipes, Interceptors, Filters, Middleware

The NestJS-style request pipeline, all on `@velajs/vela`. Five component tiers plus the `APP_*` global tokens.

## The five interfaces

```ts
interface CanActivate     { canActivate(ctx: ExecutionContext): boolean | Promise<boolean>; }
interface PipeTransform<T, R> { transform(value: T, meta: ArgumentMetadata): R | Promise<R>; }
interface NestInterceptor { intercept(ctx: ExecutionContext, next: CallHandler): Promise<unknown>; }
interface ExceptionFilter<T> { catch(exception: T, ctx: ExecutionContext): unknown | Promise<unknown>; }
interface NestMiddleware  { use(c: VelaContext, next: Next): Promise<Response | void>; }  // Hono Context
```

`VelaHonoEnv`, `VelaContext`, and `VelaHono` preserve Hono types with unknown-valued context variables and object bindings. Resolve the request container with `getRequestContainer(context)` or the execution-context accessor; it is private runtime state, not a Hono variable. Inject native bindings through the declared environment token.

`ExecutionContext`: `getClass()`, `getHandler()`, `getModuleId()`, `getRequest(): Request`, `getContext(): VelaContext`, `getContainer(): Container | undefined`, `getType(): string` (including custom entrypoint kinds), `switchToHttp()`, `switchToWs()`. Transport-inapplicable accessors throw. `CallHandler.handle(): Promise<unknown>`. `ArgumentMetadata`: `{ type, metatype?: unknown, data? }`. WebSocket payloads and custom entrypoint payloads remain unknown until parsed; accessors do not accept result generics.

HTTP resolves request controllers only when the pipeline invokes the handler, after guards and argument validation. Scoped components resolve asynchronously against the declaring module; global components use application lookup. Method-scoped middleware applies to its matched HTTP method even when another method shares the path.

## Applying components

Decorators work on a controller class or a method, and accept **classes** (DI-resolved) or **instances**:

```ts
@Controller('/orders')
@UseGuards(AuthGuard)                 // class → resolved from DI
@UseInterceptors(new LoggingInterceptor())  // instance → used as-is
class OrdersController {
  @Post()
  @UseGuards(new ApiKeyGuard())
  @UseInterceptors(EnvelopeInterceptor)
  @UseFilters(ClientErrorFilter)
  create(@Body(new ValidationPipe(CreateOrder)) body: ReturnType<typeof CreateOrder.parse>) {}
}
```

`@UseGuards`, `@UsePipes`, `@UseInterceptors`, `@UseFilters`, `@UseMiddleware` are all variadic. `@Catch(...ErrorTypes)` marks an `ExceptionFilter` class for specific error types (zero args = catch-all).

On a `@Module` class they apply to the controllers that module declares (after each controller's class-level entries, before method-level ones), not to its providers or imported modules. They are resolved per application, so bootstrapping the same modules again never runs them twice.

## Global (app-wide) components

Three ways to register globals:

```ts
import { defineProvider } from '@velajs/vela';

// 1. APP_* provider tokens (multiple providers per token all run)
@Module({
  providers: [
    AuthGuard,
    defineProvider(APP_GUARD, { useExisting: AuthGuard }),
    defineProvider(APP_PIPE, { useClass: ValidationPipe }),
    defineProvider(APP_INTERCEPTOR, { useClass: SerializerInterceptor }),
    defineProvider(APP_FILTER, { useClass: AllExceptionsFilter }),
    defineProvider(APP_MIDDLEWARE, { useExisting: TraceMiddleware }),
  ],
})
class AppModule {}

// 2. App methods (chainable) — instances only
app.useGlobalGuards(new AuthGuard())
   .useGlobalPipes(new ValidationPipe())
   .useGlobalInterceptors(new SerializerInterceptor())
   .useGlobalFilters(new AllExceptionsFilter());

// 3. From a custom module via provideGlobal()
providers: [AuthGuard, ...provideGlobal('guard', AuthGuard)]
```

`APP_GUARD`, `APP_PIPE`, `APP_INTERCEPTOR`, `APP_FILTER`, `APP_MIDDLEWARE` are `InjectionToken`s. Multiple providers for one token all execute.

## Execution order

Per HTTP request:

```
guards → extract args (pipes run here) → interceptors (onion) → handler → [on throw] filters
```

Guards run before argument factories and pipes. Ordinary custom parameter factories can read guard-populated state. A lazy factory injects an explicit memoized thunk; the handler calls it to perform deferred work. It does not proxy a user value. Required custom-decorator data must be passed explicitly (see `controllers-and-routing.md`).

Merge order when combining global + controller + method:
- **Guards / pipes / interceptors** run in declaration order: **global → controller → method**.
- **Interceptors** additionally form an onion — the first-registered (global) interceptor is outermost (wraps the handler last).
- **Filters** are the one inversion: **closest-first — handler → controller → global**.

## Middleware

Two forms. Method/controller-scoped via `@UseMiddleware`, or NestJS-style route binding via a module's `configure(consumer)`:

```ts
@Module({ controllers: [UsersController] })
class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(new TraceMiddleware()).forRoutes('/users');
  }
}
```

Route targets use Hono route patterns (`:id`, `*`) and resolve at route build:

- `forRoutes(UsersController)` matches each of the controller's routes with its method, under the global prefix and URI version. A controller that declares no routes throws.
- A string or `{ path, method }` target gets the global prefix and also covers the paths beneath it: `forRoutes('/users')` under `globalPrefix: '/api'` matches `/api/users` and `/api/users/42`. Write it without the prefix.
- `exclude()` targets get the global prefix and match exactly: `exclude('/users/me')` does not exclude `/users/me/keys`.
- A `GET` target also matches `HEAD`, which Hono serves with the GET handler. `'*'` matches every request.

For authorization use the shared guards in `@velajs/authz/vela`; raw request headers are not proof of a role or permission.

## Reflector — reading metadata

Attach metadata with `@SetMetadata(key, value)` (or `Reflector.createDecorator()`), read it in a guard/interceptor:

```ts
const RequireScope = Reflector.createDecorator<string>();

class ScopeGuard implements CanActivate {
  private readonly reflector = new Reflector();
  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride(RequireScope, ctx);
    if (!required) return true;
    return getTrustedRequestIdentity(ctx.getRequest())?.roles?.includes(required) ?? false;
  }
}
```

`Reflector` methods: `get`, `getHandler`, `getClass`, `getAll` (`[handler, class]`), `getAllAndOverride` (handler ?? class), `getAllAndMerge` (concat/assign).

## Built-in pipes

| Pipe | Constructor | Behavior |
|---|---|---|
| `ParseIntPipe` | `()` | `parseInt`, throws `BadRequestException` on NaN |
| `ParseFloatPipe` | `()` | `parseFloat` |
| `ParseBoolPipe` | `()` | only `'true'`/`'false'` |
| `ParseUUIDPipe` | `({ version?: '3'\|'4'\|'5' })` | UUID validation |
| `ParseEnumPipe` | `(enumType)` | value must be in the enum |
| `ParseArrayPipe` | `({ separator?, optional? })` | split + trim (default sep `,`) |
| `DefaultValuePipe` | `(defaultValue)` | fill `undefined`/`null` |
| `RequiredPipe` | `()` | throw on `undefined`/`null`/`''` |
| `ValidationPipe` | `(schema?)` | Standard Schema, parser, or `defineDto` descriptor; issues become 400 |

```ts
params(
  @Param('id', ParseIntPipe) id: number,
  @Param('uuid', new ParseUUIDPipe({ version: '4' })) uuid: string,
  @Query('active', new DefaultValuePipe('false'), ParseBoolPipe) active: boolean,
  @Query('tags', new ParseArrayPipe({ separator: '|' })) tags: string[],
) {}
```

## Exception filters

```ts
@Catch(BadRequestException, ForbiddenException)
class ClientErrorFilter implements ExceptionFilter {
  catch(exception: HttpException, _ctx: ExecutionContext): unknown {
    return { filteredBy: 'client-error', status: exception.getStatus() };
  }
}
```

The built-in `HttpException` family and health checks are covered in `errors-and-health.md`.
