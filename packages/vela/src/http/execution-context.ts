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

/**
 * `ExecutionContext.getClass()` for HTTP failures outside a controller handler:
 * middleware (including the framework's body and query limits), unmatched
 * routes, and the application's last-resort error handler. `ExceptionHandler.render`
 * (and, for middleware failures, exception filters) receive this synthesized
 * context there; `getType()` stays `'http'` for NestJS parity.
 */
export class VelaMiddlewareHost {}

/**
 * `ExecutionContext.getHandler()` for a failure raised by middleware, including
 * the framework's request limits. There is no controller class or handler
 * method on the call stack at that point, so the context reports stable,
 * comparable markers instead.
 */
export const VELA_MIDDLEWARE_HANDLER: unique symbol = Symbol.for('vela.middleware');

/** `ExecutionContext.getHandler()` when no route matched the request. */
export const VELA_NOT_FOUND_HANDLER: unique symbol = Symbol.for('vela.not-found');

export function buildMiddlewareExecutionContext(c: Context): HttpExecutionContext {
  return buildExecutionContext(c, VelaMiddlewareHost, VELA_MIDDLEWARE_HANDLER);
}

export function buildNotFoundExecutionContext(c: Context): HttpExecutionContext {
  return buildExecutionContext(c, VelaMiddlewareHost, VELA_NOT_FOUND_HANDLER);
}
