import './metadata';
export { defineMetadata, getMetadata } from './metadata';

// Factory & Application
export { VelaFactory } from './factory';
export { VelaApplication } from './application';

// DI Container
export { Container, Injectable, Inject, InjectionToken } from './container/index';
export type {
  Type,
  Token,
  InjectableOptions,
  ProviderOptions,
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
  Sse,
  Param,
  Query,
  Body,
  Headers,
  Req,
  HttpCode,
  Header,
  Redirect,
  createParamDecorator,
} from './http/index';

// Services
export { Logger, LogLevel } from './services/index';
export type { LoggerService } from './services/index';

// Config
export { ConfigModule, ConfigService, CONFIG_OPTIONS } from './config/index';
export type { ConfigModuleOptions } from './config/index';

// Module
export { Module } from './module/index';
export type { ModuleOptions, DynamicModule } from './module/index';

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
  DefaultValuePipe,
  RequiredPipe,
  ZodValidationPipe,
} from './pipeline/index';

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

// Registry (for advanced usage)
export { MetadataRegistry } from './registry/index';

// Module internals (for @velajs/testing and advanced usage)
export { RouteManager } from './http/index';
export { ModuleLoader } from './module/index';

// Component Manager (for advanced usage)
export { ComponentManager } from './pipeline/index';
