import type { Context } from 'hono';
import type { Type } from '../container/types';
import type { HttpExecutionContext } from '../pipeline/types';
import { findRequestContainer } from './request-container';

// Private request-local bridge for custom param decorators, which construct
// their own ExecutionContext from the same Hono Context after guards run.
// WeakMap prevents application middleware from forging the declaring module.
const moduleIdByContext = new WeakMap<object, string>();

// Single source of ExecutionContext shape — used by the route pipeline AND
// by createParamDecorator's deferred factory call.
export function buildExecutionContext(
  c: Context,
  controller: Type,
  handlerName: string | symbol,
  moduleId?: string,
): HttpExecutionContext {
  if (moduleId !== undefined) moduleIdByContext.set(c, moduleId);
  const ownerModuleId = moduleId ?? moduleIdByContext.get(c);
  return {
    getType: () => 'http',
    getClass: () => controller,
    getHandler: () => handlerName,
    getModuleId: () => ownerModuleId,
    getContainer: () => findRequestContainer(c),
    getContext: () => c,
    getRequest: () => c.req.raw,
    switchToHttp: () => ({
      getRequest: () => c.req.raw,
      getResponse: () => c,
    }),
    switchToWs: () => {
      throw new Error(
        'switchToWs() called on an HTTP ExecutionContext. This handler runs over HTTP, not a WebSocket gateway.',
      );
    },
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

export function buildMiddlewareExecutionContext(c: Context): HttpExecutionContext {
  return buildExecutionContext(c, VelaMiddlewareHost, VELA_MIDDLEWARE_HANDLER);
}
