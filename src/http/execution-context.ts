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
