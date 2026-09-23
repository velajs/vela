import './metadata';
export { defineMetadata, getMetadata } from './metadata';

// Factory & Application
export { VelaFactory } from './factory';
export { VelaApplication } from './application';
export { bootstrap } from './factory/bootstrap';
export type { BootstrapOptions, BootstrapResult } from './factory/bootstrap';

// Runtime environment: bindings, variables and secrets seeded per application
export { ENV, InjectEnv } from './env';
export type { VelaEnv } from './env';

// OpenAPI
export {
  createOpenApiDocument,
  defineEndpoint,
  Endpoint,
  ApiDoc,
  ApiTags,
  ApiResponse,
  zodToJsonSchema,
} from './openapi/index';
export type {
  EndpointDefinition,
  EndpointBodyOptions,
  EndpointBodyContract,
  EndpointFormLimits,
  EndpointFormField,
  EndpointHandlerOutput,
  EndpointResponseFormat,
  EndpointResponseOutput,
  EndpointBinaryBody,
  EndpointRequest,
  EndpointSchema,
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
  MissingInjectionMetadataError,
  ModuleVisibilityError,
  MultipleProvidersFoundError,
  ROOT_MODULE_ID,
  UnresolvedDependencyError,
  mixin,
  describeToken,
  defineProvider,
} from './container/index';
export type {
  Type,
  Token,
  TypedToken,
  DependencyToken,
  InferToken,
  InferTokens,
  InjectableOptions,
  ProviderDefinition,
  ProviderSnapshot,
  ModuleScope,
  ModuleDescription,
  ContainerOptions,
  Diagnostics,
  MissingInjectionMetadataReason,
  UnresolvedDependency,
  UnresolvedDependencyReason,
  ModuleRefContext,
  ModuleRefLookupOptions,
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
  readJsonBody,
  UrlGeneratorService,
  SignedUrlGuard,
  SignedUrl,
  URL_SIGNING_SECRET,
  DEFAULT_BODY_LIMIT_BYTES,
  DEFAULT_QUERY_BYTES_LIMIT,
  DEFAULT_QUERY_DEPTH_LIMIT,
  DEFAULT_QUERY_PARAMETER_LIMIT,
} from './http/index';
export type {
  RouteOptions,
  SchemaParamDecorator,
  ReadJsonBodyOptions,
  UrlForOptions,
  SignedUrlGenerateOptions,
  VelaRouteMap,
  RouteName,
  RouteParams,
  VelaSecurityOptions,
  VelaBodySecurityOptions,
  VelaBodyLimitOverride,
  VelaQuerySecurityOptions,
} from './http/index';

// Edge-safe HMAC signed-URL primitives (also re-exported from `@velajs/vela/storage`)
export {
  signUrl,
  verifySignedUrl,
  HTTP_SIGNED_URL_PURPOSE,
  STORAGE_SIGNED_URL_PURPOSE,
} from './crypto/signed-url';
export type { SignedUrlOptions, VerifySignedUrlOptions } from './crypto/signed-url';

// Internal-dispatch seam (`ctx.run`): re-enter the app through a per-invocation
// SIGNED route (scoped claim, short expiry, single-use nonce — no shared bearer).
// Consumed by queue / schedule / (future) workflow handlers.
export {
  InternalDispatcher,
  SignedInvocationGuard,
  SignedInvocation,
  MemoryNonceStore,
  INVOCATION_SIGNING_SECRET,
  NONCE_STORE,
} from './dispatch/index';
export type {
  InvocationTransport,
  InvocationTarget,
  InvocationRouteTarget,
  InvocationPathTarget,
  RunInit,
  NonceStore,
} from './dispatch/index';
export {
  signInvocation,
  verifyInvocation,
  INVOCATION_AUDIENCE,
  INVOCATION_DEFAULT_TTL_SECONDS,
} from './crypto/invocation';
export type { InvocationClaim, VerifyInvocationOptions } from './crypto/invocation';

// Request-scoped context primitive
export { REQUEST_CONTEXT, RequestContextKey } from './http/request-context';
export type { RequestContext } from './http/request-context';
export {
  clearTrustedRequestIdentity,
  getTrustedRequestIdentity,
  setTrustedRequestIdentity,
  setTrustedRequestTenant,
  createTrustedRequestIdentityStore,
  bindTrustedRequestContext,
  getTrustedContextRequest,
} from './http/trusted-request-identity';
export type {
  TrustedRequestIdentity,
  TrustedRequestPrincipal,
  TrustedRequestIdentityStore,
} from './http/trusted-request-identity';

// Explicit request-child container access (for programmatic-route authors,
// param-decorator factories, and scoped middleware)
export { getRequestContainer } from './http/request-container';
export { buildExecutionContext as buildHttpExecutionContext } from './http/execution-context';

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
  registerAs,
} from './config/index';

// Browser/HTTP hardening
export {
  SecurityModule,
  SECURITY_OPTIONS,
  buildSecurityMiddleware,
  Secret,
} from './security/index';
export type {
  SecurityModuleOptions,
  SecurityCorsOptions,
  OriginProtectionOptions,
  SecurityHeadersOptions,
} from './security/index';
export type {
  ConfigModuleOptions,
  ConfigSchema,
  ConfigNamespace,
  AnyConfigNamespace,
  ConfigType,
  ConfigShape,
  ConfigPath,
  ConfigPathValue,
} from './config/index';

// HTTP Client
export {
  HttpModule,
  HttpService,
  HTTP_MODULE_OPTIONS,
  HttpRequestException,
  HttpResponseSizeException,
} from './fetch/index';
export type {
  HttpModuleOptions,
  HttpResponse,
  HttpRequestConfig,
  RequestConfig,
  HttpFetch,
  HttpTransport,
  HttpClientRequest,
  HttpClientResponse,
  HttpClientRequestObserver,
  HttpClientObserver,
} from './fetch/index';

// CORS
export { CorsModule, CORS_OPTIONS } from './cors/index';
export type { CorsOptions } from './cors/index';

// Cache
export {
  ResponseCacheModule,
  ResponseCacheService,
  ResponseCacheInterceptor,
  CacheResponse,
  MemoryCacheInvalidationStore,
  RESPONSE_CACHE_OPTIONS,
  CacheModule,
  CacheService,
  CacheInterceptor,
  MemoryCacheStore,
  TieredCacheStore,
  Cacheable,
  CacheKey,
  CacheTTL,
  CACHE_MANAGER,
  CACHE_MODULE_OPTIONS,
  CACHEABLE_METADATA,
  CACHE_KEY_METADATA,
  CACHE_TTL_METADATA,
} from './cache/index';
export type {
  Awaitable,
  ResponseCacheScope,
  CacheInvalidationStore,
  CacheInvalidationResult,
  ResponseCacheEntryOptions,
  CacheResponseOptions,
  ResponseCacheOptions,
  ScopedResponseCache,
  CacheModuleOptions,
  CacheStore,
  AsyncCacheStore,
  AnyCacheStore,
  CacheEntry,
  CacheEntryReader,
  CacheEntryWriter,
} from './cache/index';

// Event Emitter
export {
  EventEmitterModule,
  EventEmitter,
  EventEmitterSubscriber,
  OnEvent,
  ON_EVENT_METADATA,
} from './event-emitter/index';
export type { EventHandler, OnEventMetadata, EventEmitOptions } from './event-emitter/index';

// Schedule
export {
  ScheduleModule,
  ScheduleRegistry,
  Cron,
  Interval,
  parseCron,
  parseCronMetadata,
  parseIntervalMetadata,
  invokeScheduledJob,
  cronDialectAmbiguity,
  scheduledJobComponents,
  CRON_METADATA,
  INTERVAL_METADATA,
  SCHEDULE_DISPATCH,
  SCHEDULE_INVOCATION_SEED,
} from './schedule/index';
export type {
  RegisteredCronJob,
  RegisteredIntervalJob,
  CronMetadata,
  IntervalMetadata,
  CronMatcher,
  CronOptions,
  CronInvocation,
  IntervalInvocation,
  ScheduleDecorator,
  ScheduleInvocation,
  ScheduleInvocationSeed,
  ScheduleDispatchMode,
  ScheduleJobRef,
  InvokeScheduledJobOptions,
} from './schedule/index';

// WebSocket (edge-safe core; transport-facing internals live at @velajs/vela/websocket)
export {
  WebSocketModule,
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WebSocketServer,
  ReservedWsEvent,
  WsDispatcher,
  WsException,
  assertWebSocketRoomId,
  trySendWebSocketFrame,
  WS_SERVER,
  RESERVED_WS_EVENT_PREFIX,
} from './websocket/index';
export type {
  WebSocketModuleOptions,
  WsClient,
  WsServer,
  WsMessage,
  WsResponse,
  ReservedWsEventMetadata,
  ReservedWsEventHandler,
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
  lazyProvider,
  moduleToken,
  provideGlobal,
  sideEffectModule,
  UndefinedModuleError,
  ROOT_MODULE,
} from './module/index';
export type {
  ModuleOptions,
  DynamicModule,
  AsyncModuleOptions,
  ModuleImport,
  ModuleRegistrationOptions,
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
  ModuleEntryList,
} from './module/index';
export type { MiddlewareConsumer, NestModule, RouteInfo } from './http/index';

// Discovery — decorator-driven provider discovery (the public replacement for
// hand-rolled bootstrap scans)
export { DiscoveryService, createDiscoverableDecorator } from './discovery/index';
export type {
  DiscoveredClass,
  DiscoveredRegistration,
  DiscoveredRegisteredMethodMeta,
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
  EXECUTION_LIFETIME,
  createExecutionScope,
  getExecutionLifetime,
  finishExecutionScope,
  getEntrypointModuleId,
  resolveEntrypoint,
  buildEntrypointExecutionContext,
} from './entrypoint/index';
export type {
  ContributesEntrypoints,
  Entrypoint,
  EntrypointKind,
  EntrypointExecutionContext,
  ExecutionLifetime,
  ExecutionScope,
  ExecutionScopeOptions,
} from './entrypoint/index';

// Route contribution — metadata-claimed route generators (@Crud-style)
export { registerRouteContributor, getRouteContributors } from './http/route-contributor';
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
  getScopedComponents,
  resolveScopedComponents,
  resolveScopedComponentsAsync,
  resolvePipelineComponents,
  type PipelineComponentEntry,
  APP_GUARD,
  APP_PIPE,
  APP_INTERCEPTOR,
  APP_FILTER,
  APP_MIDDLEWARE,
  APP_EXCEPTION_HANDLER,
  ERROR_CATALOG,
} from './pipeline/index';
export type { PipelineRunOptions, ResolvedComponentMap } from './pipeline/index';

// Pipeline Types
export type {
  HttpArgumentsHost,
  HttpExecutionContext,
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

// Exception handling — the ExceptionHandler contract + shared error reporter.
// Re-exports the core @velajs/errors surface so app authors need one import to
// author handlers, throw branded errors, and define/compose catalogs.
export { ErrorsModule, matchesAny, resolveErrorReporter } from './exceptions/index';
export type {
  ErrorMatcher,
  ErrorReportContext,
  ErrorsModuleOptions,
  ExceptionHandler,
  ErrorReporter,
} from './exceptions/index';
export {
  VelaError,
  isVelaError,
  defineErrorCatalog,
  composeCatalogs,
  toErrorBody,
  CORE_CATALOG,
} from '@velajs/errors';
export type { Catalog, ErrorBodyResult, ErrorCatalogEntry, VelaErrorOptions } from '@velajs/errors';

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
export { defineDto, ValidationPipe } from './validation/index';
export {
  isStandardSchema,
  validateSchema,
  standardJsonSchema,
  SchemaValidationError,
  parseSchema,
  parseSchemaAsync,
  isValidationSchema,
} from './validation/index';
export type {
  StandardSchemaV1,
  StandardJSONSchemaV1,
  StandardDtoDefinition,
  ValidationSchema,
  SchemaInput,
  SchemaOutput,
  ValidationIssue,
} from './validation/index';
export type {
  DtoDefinition,
  DtoOptions,
  DtoSchema,
  RuntimeParser,
  SchemaParser,
} from './validation/index';

// Serialization
export {
  Serialize,
  SerializerInterceptor,
  SERIALIZE_METADATA,
  defineSerializer,
} from './serialization/index';
export type { SerializationDescriptor, SerializerDefinition } from './serialization/index';

// Testing utilities live in @velajs/testing — see https://github.com/velajs/testing

// Hono Adapter Utilities
export type { VelaContext, VelaHono, VelaHonoEnv, VelaMiddlewareHandler } from './http/hono.types';

export { defineEvent, defineEventVocabulary, EventDispatcher } from './event-emitter/index';
export type {
  EventDefinition,
  EventVocabulary,
  EventInput,
  EventPayload,
  ScopedEventDispatcher,
  EventListenerDecorator,
} from './event-emitter/index';

// Application-owned structured logging (optional; legacy Logger/Writer unchanged).
export {
  ApplicationLogger,
  StructuredLogger,
  consoleLogSink,
  loggerForScope,
  APP_LOGGER,
  LoggingModule,
  serializeLogValue,
  parseLogDirective,
} from './logging/index';
export type {
  LogValue,
  LogRecord,
  LogSink,
  LogFields,
  LogSerializationOptions,
  ApplicationLoggerOptions,
  LogDeliveryContext,
  LogThresholds,
} from './logging/index';
