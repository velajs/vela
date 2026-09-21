import type { Container } from '../container/container';
import type { TypedToken } from '../container/types';
import { instantiateMany, instantiateManyAsync } from '../http/instantiate';
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

/** An instance or typed provider token for the selected pipeline component kind. */
export type PipelineComponentEntry<T extends ComponentType> =
  | ResolvedComponentMap[T]
  | TypedToken<ResolvedComponentMap[T]>;

/**
 * Resolve explicit lists (for example app-global components) asynchronously.
 * Omitting moduleId preserves application-level lookup; scoped lists should
 * supply their declaring owner. Resolution preserves declaration order.
 */
export function resolvePipelineComponents<T extends ComponentType>(
  _type: T,
  entries: readonly PipelineComponentEntry<NoInfer<T>>[],
  container: Container,
  moduleId?: string,
): Promise<ResolvedComponentMap[T][]> {
  return instantiateManyAsync<ResolvedComponentMap[T]>(entries, container, moduleId);
}

/**
 * Class-level then method-level components. The caller owns ordering policy:
 * reverse filters for closest-first handling, and choose transport globals
 * separately. Synchronous resolution remains available for 1.x callers.
 */
export function resolveScopedComponents<T extends ComponentType>(
  type: T,
  targetClass: Constructor,
  methodName: string | symbol,
  container: Container,
  moduleId?: string,
): ResolvedComponentMap[T][] {
  // MetadataRegistry's ComponentTypeMap and this result map share the same
  // discriminant, but TypeScript cannot retain that indexed correlation.
  const scoped = ComponentManager.getScopedComponents(
    type,
    targetClass,
    methodName,
  ) as PipelineComponentEntry<T>[];
  return instantiateMany<ResolvedComponentMap[T]>(scoped, container, moduleId);
}

/** Async factories and lazy modules use the same ownership and metadata as sync dispatch. */
export function resolveScopedComponentsAsync<T extends ComponentType>(
  type: T,
  targetClass: Constructor,
  methodName: string | symbol,
  container: Container,
  moduleId?: string,
): Promise<ResolvedComponentMap[T][]> {
  // MetadataRegistry's ComponentTypeMap and this result map share the same
  // discriminant, but TypeScript cannot retain that indexed correlation.
  const scoped = ComponentManager.getScopedComponents(
    type,
    targetClass,
    methodName,
  ) as PipelineComponentEntry<T>[];
  return instantiateManyAsync<ResolvedComponentMap[T]>(scoped, container, moduleId);
}
