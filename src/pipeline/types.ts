import type { Context } from 'hono';
import type { Type } from '../container/types';

export interface ExecutionContext {
  getType<T extends string = 'http'>(): T;
  getClass(): Type;
  getHandler(): string | symbol;
  getContext<T = Context>(): T;
  getRequest(): Request;
}

export interface CanActivate {
  canActivate(context: ExecutionContext): boolean | Promise<boolean>;
}

export interface CallHandler {
  handle(): Promise<unknown>;
}

export interface NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Promise<unknown>;
}

export interface ArgumentMetadata {
  type: string;
  metatype?: Type;
  data?: string;
}

export interface PipeTransform<T = unknown, R = unknown> {
  transform(value: T, metadata: ArgumentMetadata): R | Promise<R>;
}

export interface ExceptionFilter<T = unknown> {
  catch(exception: T, context: ExecutionContext): unknown | Promise<unknown>;
}

export interface NestMiddleware {
  use(c: import('hono').Context, next: import('hono').Next): Promise<Response | void>;
}
