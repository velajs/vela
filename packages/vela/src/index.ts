// @velajs/vela — the application kit: what an application needs to declare
// modules, providers, controllers and their request pipeline, and to start the
// application. Optional features live on their own subpaths (`/cache`,
// `/schedule`, `/openapi`, …), the seams for module and adapter authors on
// `/module-kit`, and framework plumbing on `/internal`. A name is exported from
// exactly one entry.
import './metadata';

// Factory & Application
export { VelaFactory } from './factory';
export type { VelaCreateOptions } from './factory';
export { VelaApplication } from './application';

// Runtime environment: bindings, variables and secrets seeded per application
export { ENV, InjectEnv } from './env';
export type { VelaEnv } from './env';

// Dependency injection
export {
  Injectable,
  Inject,
  Optional,
  InjectionToken,
  ForwardRef,
  forwardRef,
  ModuleRef,
  mixin,
  defineProvider,
} from './container/index';
export type {
  Type,
  Token,
  TypedToken,
  DependencyToken,
  InjectableOptions,
  Provider,
  ProviderDefinition,
  ProviderLiteral,
  TypedProviderLiteral,
  ModuleRefContext,
  ModuleRefLookupOptions,
} from './container/index';
export { Scope } from './constants';

// Controllers, routes and parameters
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
  VERSION_NEUTRAL,
  Param,
  Query,
  Body,
  Headers,
  Req,
  Ctx,
  Res,
  Ip,
  Cookie,
  Cookies,
  RawBody,
  HttpCode,
  Header,
  Redirect,
  createParamDecorator,
  applyDecorators,
  UrlGeneratorService,
  SignedUrlGuard,
  SignedUrl,
  URL_SIGNING_SECRET,
} from './http/index';
export type {
  RouteOptions,
  SchemaParamDecorator,
  MessageEvent,
  SseResult,
  RouteVersion,
  VersionValue,
  GlobalPrefixOptions,
  RoutePathOptions,
  VersioningOptions,
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

// Request context
export { REQUEST_CONTEXT, RequestContextKey } from './http/request-context';
export type { RequestContext } from './http/request-context';

// Logger
export { Logger, LogLevel } from './services/index';
export type { LoggerService, ContextProvider, Writer, LoggerLevelName } from './services/index';

// Config
export { ConfigModule, ConfigService, registerAs } from './config/index';
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

// Modules
export { Global, Module, ConfigurableModuleBuilder, defineModule } from './module/index';
export type {
  ModuleOptions,
  ModuleDecoratorOptions,
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
  DefineModuleSpec,
  GlobalComponentSlot,
  ModuleContributions,
  ModuleSetupContext,
  MiddlewareConsumer,
  NestModule,
  RouteInfo,
} from './module/index';

// Invocation lifetime: extend work past the response or the scheduled event
export { EXECUTION_LIFETIME } from './entrypoint/execution-scope';
export type { ExecutionLifetime } from './entrypoint/execution-scope';

// Guards, pipes, interceptors, filters and middleware
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
  APP_EXCEPTION_HANDLER,
  ERROR_CATALOG,
  ParseIntPipe,
  ParseFloatPipe,
  ParseBoolPipe,
  ParseUUIDPipe,
  ParseEnumPipe,
  ParseArrayPipe,
  DefaultValuePipe,
  RequiredPipe,
} from './pipeline/index';
export type {
  HttpArgumentsHost,
  HttpExecutionContext,
  ExecutionContext,
  HandlerFunction,
  CanActivate,
  CallHandler,
  NestInterceptor,
  NestMiddleware,
  PipeTransform,
  ExceptionFilter,
  ArgumentMetadata,
  ReflectableDecorator,
  CreateDecoratorOptions,
  ReflectorContext,
  ReflectorTarget,
  ParseUUIDPipeOptions,
  ParseArrayPipeOptions,
} from './pipeline/index';

// HTTP exceptions
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
export type { ExceptionResponse, HttpErrorResponse, HttpExceptionOptions } from './errors/index';

// Exception handling — the ExceptionHandler contract, plus the core
// @velajs/errors surface so one import authors handlers, throws branded errors,
// and defines/composes catalogs.
export { ErrorsModule, getErrorStatus, matchesAny, renderHttpError } from './exceptions/index';
export type {
  ErrorMatcher,
  ErrorReportContext,
  ErrorsModuleOptions,
  ExceptionHandler,
  RenderedHttpError,
  RenderHttpErrorOptions,
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

// Response serialization
export {
  Serialize,
  SerializerInterceptor,
  SERIALIZE_METADATA,
  defineSerializer,
} from './serialization/index';
export type { SerializationDescriptor, SerializerDefinition } from './serialization/index';

// Hono adapter types
export type { VelaContext, VelaHono, VelaHonoEnv, VelaMiddlewareHandler } from './http/hono.types';
