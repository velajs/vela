import type { Context } from 'hono';
import type { Type } from '../container/types';

/**
 * HTTP-specific arguments host returned by `ExecutionContext.switchToHttp()`.
 * In Vela/Hono, the `Context` object holds both request and response state.
 *
 * - `getRequest()` — the Web `Request` object
 * - `getResponse()` — the Hono `Context` (use `c.header()`, `c.setCookie()`, etc.)
 */
export interface HttpArgumentsHost {
  getRequest<T = Request>(): T;
  getResponse<T = Context>(): T;
}

export interface ExecutionContext {
  getType<T extends string = 'http'>(): T;
  getClass(): Type;
  getHandler(): string | symbol;
  /** Returns the Hono `Context` directly. */
  getContext<T = Context>(): T;
  /** Shorthand for `switchToHttp().getRequest()` — returns the Web `Request`. */
  getRequest(): Request;
  /** Switch to the HTTP arguments host for NestJS-style `getRequest()` / `getResponse()` access. */
  switchToHttp(): HttpArgumentsHost;
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
