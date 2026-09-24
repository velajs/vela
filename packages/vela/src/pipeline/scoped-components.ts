import type { Container } from '../container/container';
import type { Type, TypedToken } from '../container/types';
import { instantiateMany, instantiateManyAsync } from '../http/instantiate';
import {
  inheritedClassComponents,
  inheritedHandlerComponents,
} from '../registry/inherited-metadata';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { ComponentType, ComponentTypeMap, Constructor } from '../registry/types';
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
 * Declared (unresolved) scoped components in pipeline order: class-level,
 * then module-level (`@UseGuards` etc. on the module class, applied to the
 * controllers that module instance declares), then method-level. Module-level
 * entries are read from the application's module graph in `container`, so
 * bootstrapping the same classes again never accumulates entries. Without
 * `moduleId`, the class's owning module is used when it has exactly one.
 *
 * As in Nest, a class inherits its ancestors' declarations: their class-level
 * components run first, then its own, and a method it inherits unchanged runs
 * the components each ancestor declares on it, then its own. A method the
 * class overrides runs only its own.
 */
export function getScopedComponents<T extends ComponentType>(
  type: T,
  targetClass: Constructor,
  methodName: string | symbol,
  container: Container,
  moduleId?: string,
): ComponentTypeMap[T][] {
  return [
    ...inheritedClassComponents(type, targetClass),
    ...getModuleComponents(type, targetClass, container, moduleId),
    ...inheritedHandlerComponents(type, targetClass, methodName),
  ];
}

function getModuleComponents<T extends ComponentType>(
  type: T,
  targetClass: Constructor,
  container: Container,
  moduleId: string | undefined,
): ComponentTypeMap[T][] {
  // Registered classes are concrete; the container indexes them as `Type`.
  const owners = moduleId === undefined ? container.getOwnerModuleIds(targetClass as Type) : [];
  const ownerId = moduleId ?? (owners.length === 1 ? owners[0] : undefined);
  const scope = ownerId === undefined ? undefined : container.getModuleScope(ownerId);
  if (!scope?.moduleClass || !scope.controllers?.has(targetClass)) return [];
  return MetadataRegistry.getController(type, scope.moduleClass);
}

/**
 * Resolve {@link getScopedComponents}. The caller owns ordering policy:
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
  const scoped = getScopedComponents(
    type,
    targetClass,
    methodName,
    container,
    moduleId,
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
  const scoped = getScopedComponents(
    type,
    targetClass,
    methodName,
    container,
    moduleId,
  ) as PipelineComponentEntry<T>[];
  return instantiateManyAsync<ResolvedComponentMap[T]>(scoped, container, moduleId);
}
