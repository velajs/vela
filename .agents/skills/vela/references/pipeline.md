# Request Pipeline — Guards, Pipes, Interceptors, Filters, Middleware

The NestJS-style request pipeline, all on `@velajs/vela`. Five component tiers plus the `APP_*` global tokens.

## The five interfaces

```ts
interface CanActivate     { canActivate(ctx: ExecutionContext): boolean | Promise<boolean>; }
interface PipeTransform<T, R> { transform(value: T, meta: ArgumentMetadata): R | Promise<R>; }
interface NestInterceptor { intercept(ctx: ExecutionContext, next: CallHandler): Promise<unknown>; }
interface ExceptionFilter<T> { catch(exception: T, ctx: ExecutionContext): unknown | Promise<unknown>; }
interface NestMiddleware  { use(c: Context, next: Next): Promise<Response | void>; }  // Hono Context
```

`ExecutionContext`: `getClass()`, `getHandler()`, `getRequest(): Request`, `getContext<T = Context>()` (the Hono context), `getType()` (`'http' | 'ws'`), `switchToHttp()`, `switchToWs()`. `CallHandler.handle(): Promise<unknown>`. `ArgumentMetadata`: `{ type, metatype?, data? }`.

## Applying components

Decorators work on a controller class or a method, and accept **classes** (DI-resolved) or **instances**:

```ts
@Controller('/orders')
@UseGuards(AuthGuard)                 // class → resolved from DI
@UseInterceptors(new LoggingInterceptor())  // instance → used as-is
class OrdersController {
  @Post()
  @UseGuards(new ApiKeyGuard())
  @UsePipes(new ValidationPipe())
  @UseInterceptors(EnvelopeInterceptor)
  @UseFilters(ClientErrorFilter)
  create(@Body() body: CreateOrderDto) {}
}
```

`@UseGuards`, `@UsePipes`, `@UseInterceptors`, `@UseFilters`, `@UseMiddleware` are all variadic. `@Catch(...ErrorTypes)` marks an `ExceptionFilter` class for specific error types (zero args = catch-all).

## Global (app-wide) components

Two equivalent ways to register globals:

```ts
// 1. APP_* provider tokens (multiple providers per token all run)
@Module({
  providers: [
    AuthGuard,
    { provide: APP_GUARD, useExisting: AuthGuard },
    { provide: APP_PIPE, useClass: ValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: SerializerInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_MIDDLEWARE, useExisting: TraceMiddleware },
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
extract args (pipes run here) → guards → interceptors (onion) → handler → [on throw] filters
```

Vela extracts arguments **before** guards run (`args → guards → handler`). A param decorator that needs guard-populated state must use `createLazyParamDecorator` (see `controllers-and-routing.md`).

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

## Reflector — reading metadata

Attach metadata with `@SetMetadata(key, value)` (or `Reflector.createDecorator()`), read it in a guard/interceptor:

```ts
const RequireScope = (scope: string) => SetMetadata('scope', scope);

class ScopeGuard implements CanActivate {
  private readonly reflector = new Reflector();
  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string>('scope', ctx);
    if (!required) return true;
    return ctx.getRequest().headers.get('x-scope')?.split(' ').includes(required) ?? false;
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
| `ZodValidationPipe` | `(schema)` | `schema.parse(value)` (raw errors) |

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
