import type { Context } from 'hono';
import type { Type } from '../container/types';
import type { ExecutionContext } from '../pipeline/types';

// Single source of ExecutionContext shape — used by the route pipeline AND
// by createParamDecorator's deferred factory call.
export function buildExecutionContext(
  c: Context,
  controller: Type,
  handlerName: string | symbol,
): ExecutionContext {
  return {
    getType: <T extends string = 'http'>() => 'http' as T,
    getClass: () => controller,
    getHandler: () => handlerName,
    getContext: <T = Context>() => c as T,
    getRequest: () => c.req.raw,
    switchToHttp: () => ({
      getRequest: <T = Request>() => c.req.raw as T,
      getResponse: <T = Context>() => c as T,
    }),
  };
}

// Sentinel marker exposed via `ExecutionContext.getClass()` when the host is a
// vela-attached middleware rather than a controller handler. Filters that
// branch on the calling class (rare) can detect the middleware origin without
// introducing a separate `getType()` value — `getType()` stays `'http'` for
// NestJS parity.
export class VelaMiddlewareHost {}

// Synthesizes an ExecutionContext for an exception thrown inside a
// vela-attached middleware. There is no controller class or handler method
// on the call stack at that point, so `getClass()` returns the
// `VelaMiddlewareHost` marker and `getHandler()` returns the
// `vela.middleware` symbol — both stable, comparable values that filter
// authors can pattern-match against if needed.
export const VELA_MIDDLEWARE_HANDLER: unique symbol = Symbol.for('vela.middleware');

export function buildMiddlewareExecutionContext(c: Context): ExecutionContext {
  return buildExecutionContext(c, VelaMiddlewareHost as unknown as Type, VELA_MIDDLEWARE_HANDLER);
}
