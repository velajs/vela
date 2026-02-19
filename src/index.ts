import 'reflect-metadata';

// Factory & Application
export { EdgestFactory } from './factory.js';
export { EdgestApplication } from './application.js';

// DI Container
export { Container, Injectable, Inject, InjectionToken } from './container/index.js';
export type {
  Type,
  Token,
  InjectableOptions,
  ProviderOptions,
} from './container/index.js';

// Constants
export { HttpMethod, ParamType, Scope } from './constants.js';

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
  Param,
  Query,
  Body,
  Headers,
  Req,
  HttpCode,
  Header,
  Redirect,
  createParamDecorator,
} from './http/index.js';

// Module
export { Module } from './module/index.js';
export type { ModuleOptions, DynamicModule } from './module/index.js';

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
} from './pipeline/index.js';

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
} from './pipeline/index.js';

// Component Types
export type {
  MiddlewareType,
  GuardType,
  PipeType,
  InterceptorType,
  FilterType,
} from './registry/index.js';

// Built-in Pipes
export {
  ParseIntPipe,
  ParseFloatPipe,
  ParseBoolPipe,
  DefaultValuePipe,
  RequiredPipe,
  ZodValidationPipe,
} from './pipeline/index.js';

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
} from './errors/index.js';

// Lifecycle
export type {
  OnModuleInit,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnApplicationShutdown,
  BeforeApplicationShutdown,
} from './lifecycle/index.js';

// Registry (for advanced usage)
export { MetadataRegistry } from './registry/index.js';

// Component Manager (for advanced usage)
export { ComponentManager } from './pipeline/index.js';
