import type { Next } from 'hono';
import type { VelaContext as Context } from '../http/hono.types';
import type { Container } from '../container/container';
import type { Type } from '../container/types';
import type { WsClient } from '../websocket/websocket.types';

/**
 * HTTP-specific arguments host returned by `ExecutionContext.switchToHttp()`.
 * In Vela/Hono, the `Context` object holds both request and response state.
 *
 * - `getRequest()` — the Web `Request` object
 * - `getResponse()` — the Hono `Context` (use `c.header()`, `c.setCookie()`, etc.)
 */
export interface HttpArgumentsHost {
  getRequest(): Request;
  getResponse(): Context;
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
  getClient(): WsClient;
  getData(): unknown;
  getPattern(): string;
}

/** `'http'`, `'ws'`, or a custom entrypoint kind registered by an adapter. */
export type ContextType = string;

/** A handler method, as returned by `ExecutionContext.getHandler()`. */
export type HandlerFunction = (...args: never[]) => unknown;

export interface ExecutionContext {
  getType(): ContextType;
  getClass(): Type;
  /**
   * The handler method about to run, as in Nest: pass it to the Reflector
   * (`reflector.get(key, context.getHandler())`). Framework hosts without a
   * method (middleware, unmatched routes) return a stable marker function.
   */
  getHandler(): HandlerFunction;
  /** The handler's method name on `getClass()`, or a framework host's marker symbol. */
  getHandlerName(): string | symbol;
  /** Declaring module bucket for routed HTTP/WS handlers; absent for synthetic framework hosts. */
  getModuleId(): string | undefined;
  /** Framework-owned DI container for transport-neutral guards. */
  getContainer(): Container | undefined;
  /** Returns the Hono `Context` directly. Throws outside an HTTP context. */
  getContext(): Context;
  /** Shorthand for `switchToHttp().getRequest()` — returns the Web `Request`. Throws outside HTTP. */
  getRequest(): Request;
  /** Switch to the HTTP arguments host. Throws outside an HTTP context. */
  switchToHttp(): HttpArgumentsHost;
  /** Switch to the WebSocket arguments host. Throws outside a WebSocket context. */
  switchToWs(): WsArgumentsHost;
}

/** The concrete HTTP host produced by the controller and middleware pipelines. */
export interface HttpExecutionContext extends ExecutionContext {
  getType(): 'http';
  switchToWs(): never;
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
  /** Reflected runtime metadata or an explicit schema descriptor; consumers must narrow it. */
  metatype?: unknown;
  data?: string;
}

export interface PipeTransform<T = unknown, R = unknown> {
  transform(value: T, metadata: ArgumentMetadata): R | Promise<R>;
  /** Optional async entry avoids sync-probe/retry in validators with async refinements. */
  transformAsync?(value: T, metadata: ArgumentMetadata): Promise<R>;
}

export interface ExceptionFilter<T = unknown> {
  catch(exception: T, context: ExecutionContext): unknown | Promise<unknown>;
}

export interface NestMiddleware {
  use(c: Context, next: Next): Promise<Response | void>;
}
