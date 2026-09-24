import type { Type } from '../container/types';
import type { HandlerFunction } from './types';

/** The marker `getHandler()` returns for framework hosts without a handler method. */
export function frameworkHandler(): void {}

/** The method a context reports from `getHandler()`: `target.prototype[name]`. */
export function handlerFunction(target: Type, name: string | symbol): HandlerFunction {
  const handler: unknown = Reflect.get(target.prototype as object, name);
  return typeof handler === 'function' ? (handler as HandlerFunction) : frameworkHandler;
}
