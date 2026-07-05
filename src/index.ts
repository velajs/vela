import './metadata';
export { defineMetadata, getMetadata } from './metadata';

// Factory & Application
export { VelaFactory } from './factory';
export { VelaApplication } from './application';
export { bootstrap } from './factory/bootstrap';
export type { BootstrapOptions, BootstrapResult } from './factory/bootstrap';

// OpenAPI
export {
  createOpenApiDocument,
  ApiDoc,
  ApiTags,
  ApiResponse,
  zodToJsonSchema,
} from './openapi/index';
export type {
  OpenApiDocument,
  OpenApiInfo,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiPathItem,
  OpenApiRequestBody,
  OpenApiResponse,
  ApiDocMetadata,
  ApiResponseEntry,
  ApiResponseOptions,
  CreateOpenApiDocumentOptions,
  HttpVerb,
  JsonSchema,
} from './openapi/index';

// DI Container
export {
  Container,
  Injectable,
  Inject,
  Optional,
  InjectionToken,
  ForwardRef,
  forwardRef,
  ModuleRef,
  ModuleVisibilityError,
  MultipleProvidersFoundError,
  ROOT_MODULE_ID,
  mixin,
  describeToken,
} from './container/index';
export type {
  Type,
  Token,
  InferToken,
  InferTokens,
  InjectableOptions,
  ProviderOptions,
  ModuleScope,
  ModuleDescription,
  ContainerOptions,
  Diagnostics,
} from './container/index';
// Introspection: the composed route table VelaApplication.describeRoutes()
// returns (RouteManager itself stays internal-only).
export type { RouteDescription } from './http/route.manager';

// Constants
export { METADATA_KEYS, HttpMethod, ParamType, Scope } from './constants';

// HTTP Decorators
export {
  Controller,
  Version,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Options,
  Head,
  All,
  Sse,
  Param,
  Query,
  Body,
  Headers,
  Req,
  Res,
  Ip,
  Cookie,
  Cookies,
  RawBody,
  HttpCode,
  Header,
  Redirect,
  createParamDecorator,
  createLazyParamDecorator,
  applyDecorators,
  UrlGeneratorService,
  SignedUrlGuard,
  SignedUrl,
  URL_SIGNING_SECRET,
} from './http/index';
export type {
  RouteOptions,
  UrlForOptions,
  SignedUrlGenerateOptions,
  VelaRouteMap,
  RouteName,
  RouteParams,
} from './http/index';

// Edge-safe HMAC signed-URL primitives (also re-exported from `@velajs/vela/storage`)
export { signUrl, verifySignedUrl } from './crypto/signed-url';
export type { SignedUrlOptions } from './crypto/signed-url';

// Request-scoped context primitive
export { REQUEST_CONTEXT } from './http/request-context';
export type { RequestContext } from './http/request-context';

// Opt-in ambient container access (ALS via hono/context-storage)
export {
  enableAmbientContainer,
  getCurrentContainer,
  getCurrentRequestContext,
} from './http/ambient';

// Services
export { Logger, LogLevel } from './services/index';
export type { LoggerService, ContextProvider, Writer, LoggerLevelName } from './services/index';

// Config
export {
  ConfigModule,
  ConfigService,
  ConfigStore,
  CONFIG_OPTIONS,
  CONFIG_ENV,
  registerAs,
} from './config/index';
export type {
  ConfigModuleOptions,
  ConfigSchema,
  ConfigNamespace,
  AnyConfigNamespace,
  InferConfigType,
  ConfigType,
  ConfigPath,
  ConfigPathValue,
} from './config/index';

// HTTP Client
export { HttpModule, HttpService, HTTP_MODULE_OPTIONS, HttpRequestException } from './fetch/index';
export type { HttpModuleOptions, HttpResponse, HttpRequestConfig } from './fetch/index';

// CORS
export { CorsModule, CORS_OPTIONS } from './cors/index';
export type { CorsOptions } from './cors/index';

// Cache
export {
  CacheModule,
  CacheService,
  CacheInterceptor,
  MemoryCacheStore,
  TieredCacheStore,
  CacheKey,
  CacheTTL,
  CACHE_MANAGER,
  CACHE_MODULE_OPTIONS,
  CACHE_KEY_METADATA,
  CACHE_TTL_METADATA,
} from './cache/index';
export type {
  Awaitable,
  CacheModuleOptions,
  CacheStore,
  AsyncCacheStore,
  AnyCacheStore,
  CacheEntry,
} from './cache/index';

// Event Emitter
export {
  EventEmitterModule,
  EventEmitter,
  EventEmitterSubscriber,
  OnEvent,
  ON_EVENT_METADATA,
} from './event-emitter/index';
export type { EventHandler, OnEventMetadata } from './event-emitter/index';

// Schedule
export {
  ScheduleModule,
  ScheduleRegistry,
  Cron,
  Interval,
  parseCron,
  CRON_METADATA,
  INTERVAL_METADATA,
} from './schedule/index';
export type {
  RegisteredCronJob,
  RegisteredIntervalJob,
  CronMetadata,
  IntervalMetadata,
  CronMatcher,
} from './schedule/index';

// WebSocket (edge-safe core; transport-facing internals live at @velajs/vela/websocket)
export {
  WebSocketModule,
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WebSocketServer,
  WsDispatcher,
  WsException,
  WS_SERVER,
} from './websocket/index';
export type {
  WebSocketModuleOptions,
  WsClient,
  WsServer,
  WsMessage,
  WsResponse,
  WsExecutionContext,
  WsArgumentsHost,
  BroadcastCommand,
  SyncDriver,
  RoomRegistry,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from './websocket/index';

// Health
export {
  HealthModule,
  HealthCheckService,
  HealthIndicatorService,
  HttpHealthIndicator,
} from './health/index';
export type {
  HealthCheckResult,
  HealthCheckStatus,
  HealthIndicatorResult,
  HealthIndicatorFunction,
  ResponseCheckCallback,
  HttpPingOptions,
} from './health/index';

// Throttler
export {
  ThrottlerModule,
  ThrottlerGuard,
  ThrottlerStorage,
  Throttle,
  SkipThrottle,
  THROTTLER_OPTIONS,
  THROTTLER_STORAGE,
  THROTTLE_METADATA,
  SKIP_THROTTLE_METADATA,
} from './throttler/index';
export type {
  ThrottlerModuleOptions,
  ThrottleConfig,
  ThrottlerStore,
  ThrottlerStorageRecord,
  RateLimitInfo,
} from './throttler/index';

// Module
export {
  Global,
  Module,
  defineDynamicModule,
  stableHash,
  moduleKey,
  ConfigurableModuleBuilder,
  defineConfigurableModule,
  defineModule,
  buildAsyncOptionsProviders,
  lazyProvider,
  moduleToken,
  provideGlobal,
  sideEffectModule,
} from './module/index';
export type {
  ModuleOptions,
  DynamicModule,
  AsyncModuleOptions,
  ModuleImport,
  ConfigurableModuleAsyncOptions,
  ConfigurableModuleBuilderOptions,
  ConfigurableModuleClassType,
  ConfigurableModuleExtras,
  ConfigurableModuleExtrasTransform,
  ConfigurableModuleHost,
  ConfigurableModuleOptionsFactory,
  DefineConfigurableModuleSpec,
  DefineModuleSpec,
  GlobalComponentSlot,
  ModuleContributions,
  ModuleSetupContext,
  LazyProviderSpec,
} from './module/index';
export type { MiddlewareConsumer, NestModule, RouteInfo } from './http/index';

// Discovery — decorator-driven provider discovery (the public replacement for
// hand-rolled bootstrap scans)
export {
  DiscoveryService,
  createDiscoverableDecorator,
} from './discovery/index';
export type {
  DiscoveredClass,
  DiscoveredMethodMeta,
  DiscoveryFilter,
  DiscoverableDecorator,
  CreateDiscoverableDecoratorOptions,
} from './discovery/index';

// Entrypoints — the open non-HTTP entry surface (websocket, queue, cron, …)
export {
  EntrypointRegistry,
  registerEntrypointKind,
  getEntrypointKinds,
  contributesEntrypoints,
  runInEntrypointScope,
  buildEntrypointExecutionContext,
} from './entrypoint/index';
export type {
  ContributesEntrypoints,
  Entrypoint,
  EntrypointKind,
  EntrypointExecutionContext,
} from './entrypoint/index';

// Route contribution — metadata-claimed route generators (@Crud-style)
export {
  registerRouteContributor,
  getRouteContributors,
} from './http/route-contributor';
export type {
  RouteContributor,
  RouteContributorContext,
  RouteContributorOpenApiContext,
} from './http/route-contributor';

// Runtime adapters — platform bindings for VelaFactory.create({ adapters })
export type { AdapterContext, RuntimeAdapter } from './factory/adapter';
export type { VelaCreateOptions } from './factory';

// Plugin manifest + composer
export {
  definePlugin,
  composePlugins,
  PluginRegistry,
  PluginRootModule,
  PLUGIN_REGISTRY_TOKEN,
} from './plugin/plugin';
export type { Plugin } from './plugin/plugin';

// Pipeline Decorators
export {
  UseMiddleware,
  UseGuards,
  UsePipes,
  UseInterceptors,
  UseFilters,
  Catch,
  SetMetadata,
  Reflector,
  PipelineRunner,
  getCatchTypes,
  shouldFilterCatch,
  resolveScopedComponents,
  APP_GUARD,
  APP_PIPE,
  APP_INTERCEPTOR,
  APP_FILTER,
  APP_MIDDLEWARE,
} from './pipeline/index';
export type { PipelineRunOptions, ResolvedComponentMap } from './pipeline/index';

// Pipeline Types
export type {
  HttpArgumentsHost,
  ExecutionContext,
  CanActivate,
  CallHandler,
  NestInterceptor,
  NestMiddleware,
  PipeTransform,
  ExceptionFilter,
  ArgumentMetadata,
  ReflectableDecorator,
  CreateDecoratorOptions,
} from './pipeline/index';

// Component Types
export type {
  Constructor,
  MiddlewareType,
  GuardType,
  PipeType,
  InterceptorType,
  FilterType,
} from './registry/index';

// Built-in Pipes
export {
  ParseIntPipe,
  ParseFloatPipe,
  ParseBoolPipe,
  ParseUUIDPipe,
  ParseEnumPipe,
  ParseArrayPipe,
  DefaultValuePipe,
  RequiredPipe,
  ZodValidationPipe,
} from './pipeline/index';
export type { ParseUUIDPipeOptions, ParseArrayPipeOptions } from './pipeline/index';

// Errors
export {
  HttpException,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
  MethodNotAllowedException,
  NotAcceptableException,
  RequestTimeoutException,
  ConflictException,
  GoneException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
  UnprocessableEntityException,
  TooManyRequestsException,
  InternalServerErrorException,
  NotImplementedException,
  BadGatewayException,
  ServiceUnavailableException,
  GatewayTimeoutException,
} from './errors/index';

// Lifecycle
export type {
  OnModuleInit,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnApplicationShutdown,
  BeforeApplicationShutdown,
} from './lifecycle/index';

// MetadataRegistry — the central decoration store. Test setup typically
// uses `MetadataRegistry.clear()` between cases. Internal primitives like
// RouteManager/ModuleLoader/ComponentManager live only at @velajs/vela/internal.
export { MetadataRegistry } from './registry/metadata.registry';

// Validation
export { createZodDto, ValidationPipe } from './validation/index';
export type { CreateZodDtoOptions } from './validation/index';

// Serialization
export { Serialize, SerializerInterceptor, SERIALIZE_METADATA } from './serialization/index';

// Testing utilities live in @velajs/testing — see https://github.com/velajs/testing

// Hono Adapter Utilities
export { getRuntimeKey, env } from 'hono/adapter';
