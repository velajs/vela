import type { Container } from '../container/container';
import type { ComponentType, Constructor } from '../registry/types';
import { ComponentManager } from './component.manager';
import type {
  CanActivate,
  ExceptionFilter,
  NestInterceptor,
  NestMiddleware,
  PipeTransform,
} from './types';

export interface ResolvedComponentMap {
  guard: CanActivate;
  pipe: PipeTransform;
  interceptor: NestInterceptor;
  filter: ExceptionFilter;
  middleware: NestMiddleware;
}

const RESOLVERS = {
  guard: ComponentManager.resolveGuards.bind(ComponentManager),
  pipe: ComponentManager.resolvePipes.bind(ComponentManager),
  interceptor: ComponentManager.resolveInterceptors.bind(ComponentManager),
  filter: ComponentManager.resolveFilters.bind(ComponentManager),
  middleware: ComponentManager.resolveMiddleware.bind(ComponentManager),
} as const;

/**
 * Public seam for custom dispatchers: the `@UseGuards`/`@UsePipes`/
 * `@UseInterceptors`/`@UseFilters` components scoped to a handler (class-level
 * then method-level, declaration order), resolved to instances through the
 * given container (classes constructed with DI; instances passed through).
 *
 * Order is preserved exactly as declared — conventions stay with the CALLER:
 * filters run closest-first, so dispatchers reverse them
 * (`resolveScopedComponents('filter', ...).reverse()`), and app-wide `APP_*`
 * components are a separate, transport-specific decision.
 *
 * Promoted to the public API by the QueueModule work (the "openness proof"):
 * it was the one capability custom entrypoint dispatchers needed that only
 * the internal `ComponentManager` provided.
 */
export function resolveScopedComponents<T extends ComponentType>(
  type: T,
  targetClass: Constructor,
  methodName: string | symbol,
  container: Container,
): ResolvedComponentMap[T][] {
  const scoped = ComponentManager.getScopedComponents(type, targetClass, methodName);
  const resolve = RESOLVERS[type] as (
    items: unknown[],
    container: Container,
  ) => ResolvedComponentMap[T][];
  return resolve(scoped, container);
}
