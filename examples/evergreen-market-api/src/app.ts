import { z } from 'zod';
import type { Context } from 'hono';
import {
  All,
  ApiDoc,
  ApiResponse,
  ApiTags,
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_MIDDLEWARE,
  APP_PIPE,
  BadRequestException,
  Body,
  CacheInterceptor,
  CacheKey,
  CacheModule,
  CacheService,
  CacheTTL,
  Catch,
  ConfigModule,
  ConfigService,
  Controller,
  Cookie,
  Cookies,
  CorsModule,
  Cron,
  DefaultValuePipe,
  Delete,
  EventEmitter,
  EventEmitterModule,
  ForbiddenException,
  Get,
  Head,
  Header,
  Headers,
  HealthCheckService,
  HealthIndicatorService,
  HealthModule,
  HttpCode,
  HttpModule,
  HttpService,
  Injectable,
  Inject,
  InjectionToken,
  Interval,
  Ip,
  MetadataRegistry,
  Module,
  NotFoundException,
  OnEvent,
  Optional,
  Options,
  Param,
  ParseArrayPipe,
  ParseBoolPipe,
  ParseEnumPipe,
  ParseFloatPipe,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  RawBody,
  Redirect,
  Reflector,
  Req,
  RequiredPipe,
  Res,
  ScheduleModule,
  ScheduleRegistry,
  Scope,
  Serialize,
  SerializerInterceptor,
  SetMetadata,
  SkipThrottle,
  Sse,
  Throttle,
  ThrottlerModule,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UseMiddleware,
  UsePipes,
  ValidationPipe,
  VelaFactory,
  Version,
  applyDecorators,
  createOpenApiDocument,
  createParamDecorator,
  createZodDto,
} from '@velajs/vela';
import type {
  ArgumentMetadata,
  BeforeApplicationShutdown,
  CallHandler,
  CanActivate,
  ExceptionFilter,
  ExecutionContext,
  MiddlewareConsumer,
  NestInterceptor,
  NestMiddleware,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  OnModuleDestroy,
  OnModuleInit,
  OpenApiDocument,
  PipeTransform,
  Type,
  VelaApplication,
} from '@velajs/vela';

interface Product {
  id: number;
  name: string;
  price: number;
  tags: string[];
  secret: string;
}

interface CreateProductInput {
  name: string;
  price: number;
  tags?: string[];
}

interface ProductStore {
  list(tag?: string): Product[];
  find(id: number): Product | undefined;
  create(input: CreateProductInput): Product;
  replace(id: number, input: CreateProductInput): Product;
  update(id: number, input: Partial<CreateProductInput>): Product;
  remove(id: number): void;
}

interface EvergreenMarketFixture {
  app: VelaApplication;
  document: OpenApiDocument;
  AppModule: Type;
  tokens: {
    AUDIT_LOG: InjectionToken<string[]>;
  };
  getLifecycleEvents(): string[];
}

interface EvergreenMarketOptions {
  cors?: boolean;
}

const ProductBodySchema = z.object({
  name: z.string().min(1),
  price: z.number().positive(),
  tags: z.array(z.string()).default([]),
});

class CreateProductDto extends createZodDto(ProductBodySchema, {
  name: 'CreateProductDto',
}) {}

class PublicProductDto extends createZodDto(
  z.object({
    id: z.number(),
    name: z.string(),
    price: z.number(),
    tags: z.array(z.string()),
  }),
  { name: 'PublicProductDto' },
) {}

enum VisibilityMode {
  Public = 'public',
  Private = 'private',
}

class ExampleAppError extends Error {}

const REQUIRED_SCOPE = 'example:required-scope';

const RequireScope = (scope: string) =>
  applyDecorators(
    SetMetadata(REQUIRED_SCOPE, scope),
    Header('x-required-scope', scope),
    ApiDoc({ summary: `Requires ${scope}` }),
  );

const CurrentUser = createParamDecorator<'id' | undefined>((field, ctx) => {
  const id = ctx.getRequest().headers.get('x-user-id') ?? 'anonymous';
  return field === 'id' ? id : { id };
});

export async function createEvergreenMarketApp(
  options: EvergreenMarketOptions = {},
): Promise<EvergreenMarketFixture> {
  MetadataRegistry.clear();

  const AUDIT_LOG = new InjectionToken<string[]>('AUDIT_LOG');
  const PRODUCT_STORE = new InjectionToken<ProductStore>('PRODUCT_STORE');
  const ID_FACTORY = new InjectionToken<() => number>('ID_FACTORY');
  const DEFAULT_REGION = new InjectionToken<string>('DEFAULT_REGION', {
    factory: () => 'iad',
  });
  const OPTIONAL_LABEL = new InjectionToken<string>('OPTIONAL_LABEL');

  @Injectable()
  class InMemoryProductStore implements ProductStore {
    private products: Product[] = [
      { id: 1, name: 'Notebook', price: 12.5, tags: ['office'], secret: 'margin:high' },
      { id: 2, name: 'Keyboard', price: 49, tags: ['hardware'], secret: 'margin:medium' },
    ];

    list(tag?: string): Product[] {
      return tag ? this.products.filter((p) => p.tags.includes(tag)) : [...this.products];
    }

    find(id: number): Product | undefined {
      return this.products.find((p) => p.id === id);
    }

    create(input: CreateProductInput): Product {
      const nextId = Math.max(...this.products.map((p) => p.id), 0) + 1;
      const product = {
        id: nextId,
        name: input.name,
        price: input.price,
        tags: input.tags ?? [],
        secret: 'margin:new',
      };
      this.products.push(product);
      return product;
    }

    replace(id: number, input: CreateProductInput): Product {
      const index = this.products.findIndex((p) => p.id === id);
      if (index === -1) throw new NotFoundException(`Product ${id} not found`);
      const product = {
        id,
        name: input.name,
        price: input.price,
        tags: input.tags ?? [],
        secret: this.products[index]!.secret,
      };
      this.products[index] = product;
      return product;
    }

    update(id: number, input: Partial<CreateProductInput>): Product {
      const current = this.find(id);
      if (!current) throw new NotFoundException(`Product ${id} not found`);
      const product = {
        ...current,
        ...input,
        tags: input.tags ?? current.tags,
      };
      this.products = this.products.map((p) => (p.id === id ? product : p));
      return product;
    }

    remove(id: number): void {
      const before = this.products.length;
      this.products = this.products.filter((p) => p.id !== id);
      if (this.products.length === before) throw new NotFoundException(`Product ${id} not found`);
    }
  }

  @Injectable()
  class ProductService {
    constructor(
      @Inject(PRODUCT_STORE) private readonly store: ProductStore,
      @Inject(AUDIT_LOG) private readonly auditLog: string[],
      @Inject(ID_FACTORY) private readonly nextAuditId: () => number,
      @Inject(DEFAULT_REGION) private readonly region: string,
      private readonly config: ConfigService,
    ) {}

    list(tag?: string): Product[] {
      this.auditLog.push(`list:${tag ?? 'all'}:${this.region}`);
      return this.store.list(tag);
    }

    find(id: number): Product {
      const product = this.store.find(id);
      if (!product) throw new NotFoundException(`Product ${id} not found`);
      return product;
    }

    create(input: CreateProductInput): Product {
      const product = this.store.create(input);
      this.auditLog.push(`create:${this.nextAuditId()}:${product.id}:${this.config.get('app.name')}`);
      return product;
    }

    replace(id: number, input: CreateProductInput): Product {
      this.auditLog.push(`replace:${id}`);
      return this.store.replace(id, input);
    }

    update(id: number, input: Partial<CreateProductInput>): Product {
      this.auditLog.push(`patch:${id}`);
      return this.store.update(id, input);
    }

    remove(id: number): void {
      this.auditLog.push(`delete:${id}`);
      this.store.remove(id);
    }
  }

  @Injectable()
  class OptionalConsumer {
    constructor(@Optional() @Inject(OPTIONAL_LABEL) readonly label?: string) {}
  }

  @Injectable({ scope: Scope.REQUEST })
  class RequestMarker {
    private static next = 0;
    readonly id = ++RequestMarker.next;
  }

  @Injectable({ scope: Scope.REQUEST })
  class RequestScopeGuard implements CanActivate {
    constructor(private readonly marker: RequestMarker) {}

    canActivate(context: ExecutionContext): boolean {
      context.getContext<Context>().header('x-request-marker', String(this.marker.id));
      return true;
    }
  }

  @Injectable()
  class LifecycleProbe implements OnModuleInit, OnApplicationBootstrap, BeforeApplicationShutdown, OnModuleDestroy, OnApplicationShutdown {
    readonly events: string[] = [];

    onModuleInit(): void {
      this.events.push('module-init');
    }

    onApplicationBootstrap(): void {
      this.events.push('app-bootstrap');
    }

    beforeApplicationShutdown(signal?: string): void {
      this.events.push(`before-shutdown:${signal ?? 'none'}`);
    }

    onModuleDestroy(): void {
      this.events.push('module-destroy');
    }

    onApplicationShutdown(signal?: string): void {
      this.events.push(`app-shutdown:${signal ?? 'none'}`);
    }
  }

  @Injectable()
  class EventRecorder {
    readonly events: unknown[] = [];

    @OnEvent('product.created')
    recordProductCreated(payload: unknown): void {
      this.events.push(payload);
    }
  }

  @Injectable()
  class ScheduledTasks {
    @Cron('0 * * * *')
    hourly(): void {}

    @Interval(30000)
    poll(): void {}
  }

  @Injectable()
  class AppGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const req = context.getRequest();
      return req.headers.get('x-blocked') !== 'true';
    }
  }

  @Injectable()
  class NoopPipe implements PipeTransform {
    transform(value: unknown, _metadata: ArgumentMetadata): unknown {
      return value;
    }
  }

  @Injectable()
  class AppInterceptor implements NestInterceptor {
    async intercept(context: ExecutionContext, next: CallHandler): Promise<unknown> {
      context.getContext<Context>().header('x-app-interceptor', 'yes');
      return next.handle();
    }
  }

  @Catch(ExampleAppError)
  @Injectable()
  class AppFilter implements ExceptionFilter<ExampleAppError> {
    catch(exception: ExampleAppError, _context: ExecutionContext): unknown {
      return { filteredBy: 'app-filter', message: exception.message };
    }
  }

  @Injectable()
  class AppMiddleware implements NestMiddleware {
    async use(c: Context, next: () => Promise<void>): Promise<void> {
      c.header('x-app-middleware', 'yes');
      await next();
    }
  }

  class RouteMiddleware implements NestMiddleware {
    async use(c: Context, next: () => Promise<void>): Promise<void> {
      c.header('x-route-middleware', 'yes');
      await next();
    }
  }

  class TraceMiddleware implements NestMiddleware {
    async use(c: Context, next: () => Promise<void>): Promise<void> {
      c.header('x-consumer-middleware', 'yes');
      await next();
    }
  }

  class ApiKeyGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      return context.getRequest().headers.get('x-api-key') === 'secret';
    }
  }

  class ScopeGuard implements CanActivate {
    private readonly reflector = new Reflector();

    canActivate(context: ExecutionContext): boolean {
      const required = this.reflector.getAllAndOverride<string>(REQUIRED_SCOPE, context);
      if (!required) return true;
      const scopes = context.getRequest().headers.get('x-scope')?.split(' ') ?? [];
      return scopes.includes(required);
    }
  }

  class UppercaseNamePipe implements PipeTransform<CreateProductInput, CreateProductInput> {
    transform(value: CreateProductInput, _metadata: ArgumentMetadata): CreateProductInput {
      return { ...value, name: value.name.toUpperCase() };
    }
  }

  class EnvelopeInterceptor implements NestInterceptor {
    async intercept(_context: ExecutionContext, next: CallHandler): Promise<unknown> {
      return { data: await next.handle() };
    }
  }

  @Catch(BadRequestException, ForbiddenException)
  class ClientErrorFilter implements ExceptionFilter {
    catch(exception: BadRequestException | ForbiddenException, _context: ExecutionContext): unknown {
      return { filteredBy: 'client-error-filter', status: exception.getStatus() };
    }
  }

  @Controller({ path: '/catalog', version: 1 })
  @ApiTags('catalog')
  class CatalogController {
    constructor(
      private readonly products: ProductService,
      private readonly events: EventEmitter,
    ) {}

    @Get('/items')
    @ApiDoc({ summary: 'List products', operationId: 'listProducts' })
    @ApiResponse(200, { description: 'Product list', schema: PublicProductDto })
    list(@Query('tag') tag?: string) {
      return this.products.list(tag);
    }

    @Get('/items/:id')
    @UseInterceptors(SerializerInterceptor)
    @Serialize(PublicProductDto)
    findOne(@Param('id', ParseIntPipe) id: number) {
      return this.products.find(id);
    }

    @Version(2)
    @Get('/items/:id')
    findOneV2(@Param('id', ParseIntPipe) id: number) {
      return { version: 2, product: this.products.find(id) };
    }

    @Post('/items')
    @HttpCode(201)
    @UseGuards(new ApiKeyGuard())
    @UsePipes(new ValidationPipe(), new UppercaseNamePipe())
    @ApiResponse(201, { description: 'Created product', schema: PublicProductDto })
    async create(@Body() body: CreateProductDto) {
      const product = this.products.create(body);
      await this.events.emit('product.created', { id: product.id, name: product.name });
      return product;
    }

    @Put('/items/:id')
    @UseGuards(new ApiKeyGuard())
    @UsePipes(new ValidationPipe())
    replace(@Param('id', ParseIntPipe) id: number, @Body() body: CreateProductDto) {
      return this.products.replace(id, body);
    }

    @Patch('/items/:id')
    @UseGuards(new ApiKeyGuard())
    update(@Param('id', ParseIntPipe) id: number, @Body() body: Partial<CreateProductInput>) {
      return this.products.update(id, body);
    }

    @Delete('/items/:id')
    @HttpCode(204)
    @UseGuards(new ApiKeyGuard())
    remove(@Param('id', ParseIntPipe) id: number) {
      this.products.remove(id);
      return null;
    }

    @Head('/items/:id')
    hasItem(@Param('id', ParseIntPipe) id: number) {
      this.products.find(id);
      return { ok: true };
    }

    @Options('/items')
    @Header('allow', 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS')
    options() {
      return null;
    }

    @All('/echo-method')
    echoMethod(@Req() c: Context) {
      return { method: c.req.method };
    }

    @Get('/redirect')
    @Redirect('/api/v1/catalog/items', 302)
    redirectToList() {
      return undefined;
    }

    @Get('/scoped')
    @UseGuards(new ScopeGuard())
    @RequireScope('catalog:read')
    scoped() {
      return { scoped: true };
    }
  }

  @Controller('/surface')
  class SurfaceController {
    @Get('/params/:id/:uuid')
    params(
      @Param('id', ParseIntPipe) id: number,
      @Param('uuid', new ParseUUIDPipe({ version: '4' })) uuid: string,
      @Query('price', ParseFloatPipe) price: number,
      @Query('active', new DefaultValuePipe('false'), ParseBoolPipe) active: boolean,
      @Query('tags', new ParseArrayPipe({ separator: '|' })) tags: string[],
      @Query('mode', new ParseEnumPipe(VisibilityMode)) mode: VisibilityMode,
      @Query('required', RequiredPipe) required: string,
      @Headers('x-request-id') requestId: string,
      @Cookie('session') session: string,
      @Cookies() cookies: Record<string, string>,
      @Ip() ip: string | null,
      @CurrentUser('id') userId: string,
    ) {
      return { id, uuid, price, active, tags, mode, required, requestId, session, cookies, ip, userId };
    }

    @Post('/body-field')
    bodyField(@Body('name') name: string, @Body() body: Record<string, unknown>) {
      return { name, body };
    }

    @Post('/raw')
    raw(@RawBody() body: Uint8Array) {
      return { byteLength: body.byteLength, text: new TextDecoder().decode(body) };
    }

    @Get('/response')
    response(@Res() c: Context) {
      c.header('x-response-param', 'set');
      return { ok: true };
    }

    @Get('/text')
    text() {
      return 'plain text response';
    }

    @Sse('/events')
    events() {
      return new Response('data: example\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
  }

  @Controller('/pipeline')
  @UseFilters(new ClientErrorFilter())
  class PipelineController {
    @Get('/secure')
    @UseGuards(new ApiKeyGuard())
    @UseInterceptors(new EnvelopeInterceptor())
    secure() {
      return { ok: true };
    }

    @Get('/app-filter')
    appFilter() {
      throw new ExampleAppError('handled globally');
    }

    @Get('/blocked')
    blocked() {
      return { ok: true };
    }

    @Get('/method-middleware')
    @UseMiddleware(new RouteMiddleware())
    methodMiddleware() {
      return { ok: true };
    }
  }

  @Controller('/built-ins')
  class BuiltInsController {
    private cacheHits = 0;

    constructor(
      private readonly config: ConfigService,
      private readonly cache: CacheService,
      private readonly emitter: EventEmitter,
      private readonly events: EventRecorder,
      private readonly schedule: ScheduleRegistry,
      private readonly health: HealthCheckService,
      private readonly indicator: HealthIndicatorService,
      private readonly http: HttpService,
      private readonly optional: OptionalConsumer,
      private readonly lifecycle: LifecycleProbe,
      @Inject(AUDIT_LOG) private readonly auditLog: string[],
    ) {}

    @Get('/config')
    configValues() {
      return {
        name: this.config.get('app.name'),
        nested: this.config.get('features.examples'),
        fallback: this.config.get('missing', 'fallback'),
      };
    }

    @Get('/manual-cache')
    manualCache() {
      const current = this.cache.get<number>('manual-cache') ?? 0;
      const next = current + 1;
      this.cache.set('manual-cache', next);
      return { count: next };
    }

    @Get('/cached')
    @UseInterceptors(CacheInterceptor)
    @CacheKey('built-ins:cached')
    @CacheTTL(60)
    cached() {
      this.cacheHits += 1;
      return { count: this.cacheHits };
    }

    @Post('/events')
    async eventLog(@Body() body: { id: number; name: string }) {
      await this.emitter.emit('product.created', body);
      return body;
    }

    @Get('/event-log')
    eventLogSnapshot() {
      return { events: this.events.events };
    }

    @Get('/schedule')
    scheduleJobs() {
      return {
        cron: this.schedule.getCronJobs().map((job) => job.methodName),
        interval: this.schedule.getIntervalJobs().map((job) => job.methodName),
      };
    }

    @Get('/health')
    healthCheck() {
      return this.health.check([
        async () => this.indicator.check('app').up({ version: 'example' }),
      ]);
    }

    @Get('/http')
    async httpClient() {
      const result = await this.http.get<{ ok: boolean }>('data:application/json,%7B%22ok%22%3Atrue%7D');
      return { status: result.status, data: result.data };
    }

    @Get('/request-scope')
    requestScope() {
      return { ok: true };
    }

    @Get('/optional')
    optionalProvider() {
      return { optional: this.optional.label ?? null };
    }

    @Get('/lifecycle')
    lifecycleEvents() {
      return { events: this.lifecycle.events };
    }

    @Get('/audit')
    audit() {
      return { auditLog: this.auditLog };
    }

    @Get('/throttled')
    @Throttle({ limit: 1, ttl: 60000 })
    throttled() {
      return { ok: true };
    }

    @Get('/unthrottled')
    @SkipThrottle()
    unthrottled() {
      return { ok: true };
    }
  }

  @Controller('/middleware')
  class MiddlewareController {
    @Get()
    handle() {
      return { ok: true };
    }
  }

  @Injectable()
  @Module({
    controllers: [
      CatalogController,
      SurfaceController,
      PipelineController,
      BuiltInsController,
      MiddlewareController,
    ],
  })
  class FeatureModule {}

  @Injectable()
  @Module({
    imports: [
      ...(options.cors === false
        ? []
        : [
            CorsModule.forRoot({
              origin: 'https://example.test',
              allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
              allowHeaders: ['content-type', 'x-api-key', 'x-scope', 'x-user-id', 'x-request-id', 'x-blocked'],
            }),
          ]),
      ConfigModule.forRoot({
        config: {
          app: { name: 'evergreen-market' },
          features: { examples: true },
        },
      }),
      CacheModule.forRoot({ ttl: 60, max: 100 }),
      EventEmitterModule,
      ScheduleModule.forRoot(),
      HealthModule,
      HttpModule.forRoot(),
      ThrottlerModule.forRoot({
        limit: 100,
        ttl: 60000,
        getTracker: (request) => request.headers.get('x-test-client') ?? 'example-client',
      }),
      FeatureModule,
    ],
    providers: [
      { provide: AUDIT_LOG, useValue: [] },
      { provide: PRODUCT_STORE, useClass: InMemoryProductStore },
      {
        provide: ID_FACTORY,
        useFactory: (audit: string[]) => {
          let next = 1000;
          return () => {
            next += 1;
            audit.push(`id-factory:${next}`);
            return next;
          };
        },
        inject: [AUDIT_LOG],
      },
      ProductService,
      OptionalConsumer,
      RequestMarker,
      RequestScopeGuard,
      LifecycleProbe,
      EventRecorder,
      ScheduledTasks,
      AppGuard,
      NoopPipe,
      AppInterceptor,
      AppFilter,
      AppMiddleware,
      { provide: APP_GUARD, useExisting: AppGuard },
      { provide: APP_GUARD, useExisting: RequestScopeGuard },
      { provide: APP_PIPE, useExisting: NoopPipe },
      { provide: APP_INTERCEPTOR, useExisting: AppInterceptor },
      { provide: APP_FILTER, useExisting: AppFilter },
      { provide: APP_MIDDLEWARE, useExisting: AppMiddleware },
    ],
    exports: [AUDIT_LOG, LifecycleProbe],
  })
  class AppModule implements OnModuleInit {
    configure(consumer: MiddlewareConsumer): void {
      consumer.apply(new TraceMiddleware()).forRoutes('/api/middleware');
    }

    onModuleInit(): void {}
  }

  const app = await VelaFactory.create(AppModule, {
    globalPrefix: '/api',
    getClientIp: (c) => c.req.header('cf-connecting-ip') ?? null,
  });

  const document = createOpenApiDocument(AppModule, {
    info: { title: 'Evergreen Market API', version: '1.0.0' },
    globalPrefix: '/api',
  });
  app.mountOpenApi({ document, path: '/openapi.json' });

  return {
    app,
    document,
    AppModule,
    tokens: { AUDIT_LOG },
    getLifecycleEvents: () => app.get(LifecycleProbe).events,
  };
}
