import type { Container } from '../container/container';
import type { Token, Type } from '../container/types';

// Resolve a class/token through the container if registered, otherwise treat
// the input as a plain instance. Used by RouteManager and HandlerExecutor to
// materialize middleware, guards, pipes, interceptors, and filters per request.
export function instantiate<T>(
  classOrInstance: Type<T> | Token<T> | T,
  container: Container,
): T {
  if (typeof classOrInstance === 'function') {
    if (container.has(classOrInstance as Type<T>)) {
      return container.resolve(classOrInstance as Type<T>);
    }
    return new (classOrInstance as Type<T>)();
  }

  if (container.has(classOrInstance as Token<T>)) {
    return container.resolve(classOrInstance as Token<T>);
  }

  return classOrInstance as T;
}

export function instantiateMany<T>(
  items: Array<Type<T> | Token<T> | T>,
  container: Container,
): T[] {
  return items.map((item) => instantiate(item, container));
}
