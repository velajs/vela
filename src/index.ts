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
} from './container/index';
export type {
  Type,
  Token,
  InjectableOptions,
  ProviderOptions,
  ModuleScope,
  ContainerOptions,
  Diagnostics,
} from './container/index';

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
} from './http/index';

// Request-scoped context primitive
export { REQUEST_CONTEXT } from './http/request-context';
export type { RequestContext } from './http/request-context';

// Services
export { Logger, LogLevel } from './services/index';
export type { LoggerService, ContextProvider, Writer, LoggerLevelName } from './services/index';

// Config
export { ConfigModule, ConfigService, CONFIG_OPTIONS } from './config/index';
export type { ConfigModuleOptions } from './config/index';

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
  CacheKey,
  CacheTTL,
  CACHE_MANAGER,
  CACHE_MODULE_OPTIONS,
  CACHE_KEY_METADATA,
  CACHE_TTL_METADATA,
} from './cache/index';
export type { CacheModuleOptions, CacheStore, CacheEntry } from './cache/index';

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
} from './module/index';
export type { ModuleOptions, DynamicModule, AsyncModuleOptions, ModuleImport } from './module/index';
export type { MiddlewareConsumer, NestModule, RouteInfo } from './http/index';

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
  APP_GUARD,
  APP_PIPE,
  APP_INTERCEPTOR,
  APP_FILTER,
  APP_MIDDLEWARE,
} from './pipeline/index';

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
  OnFirstRequest,
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
