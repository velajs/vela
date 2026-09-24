import type { Type } from '../container/types';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { HandlerFunction } from './types';

/** The marker `getHandler()` returns for framework hosts without a handler method. */
export function frameworkHandler(): void {}

/**
 * The method a context reports from `getHandler()`: `target.prototype[name]`,
 * recorded as that method so the Reflector reads its metadata through it.
 * Transports also call it when they register a route or message handler.
 */
export function handlerFunction(target: Type, name: string | symbol): HandlerFunction {
  const handler: unknown = Reflect.get(target.prototype as object, name);
  if (typeof handler !== 'function') return frameworkHandler;
  MetadataRegistry.addHandlerMethod(handler, target, name);
  return handler as HandlerFunction;
}
