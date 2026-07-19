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

/**
 * WebSocket-specific arguments host returned by `ExecutionContext.switchToWs()`.
 * Populated by `@velajs/vela/websocket` when a gateway message is dispatched.
 *
 * - `getClient()` — the connected socket (`WsClient`)
 * - `getData()` — the inbound message payload (the envelope's `data`)
 * - `getPattern()` — the subscribed event name that matched
 */
export interface WsArgumentsHost {
  getClient<T = unknown>(): T;
  getData<T = unknown>(): T;
  getPattern<T = string>(): T;
}

/** The transport a component is executing under. `'http'` for routes, `'ws'` for gateway messages. */
export type ContextType = 'http' | 'ws';

export interface ExecutionContext {
  getType<T extends string = ContextType>(): T;
  getClass(): Type;
  getHandler(): string | symbol;
  /** Declaring module bucket for routed HTTP/WS handlers; absent for synthetic framework hosts. */
  getModuleId(): string | undefined;
  /** Framework-owned DI container for transport-neutral guards. */
  getContainer?<T = unknown>(): T | undefined;
  /** Returns the Hono `Context` directly. Throws on a WebSocket context. */
  getContext<T = Context>(): T;
  /** Shorthand for `switchToHttp().getRequest()` — returns the Web `Request`. Throws on a WebSocket context. */
  getRequest(): Request;
  /** Switch to the HTTP arguments host. Throws on a WebSocket context. */
  switchToHttp(): HttpArgumentsHost;
  /** Switch to the WebSocket arguments host. Throws on an HTTP context. */
  switchToWs(): WsArgumentsHost;
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
