import type { Container } from '../container/container';
import type { Type } from '../container/types';
import { MetadataRegistry } from '../registry/metadata.registry';
import type {
  ComponentType,
  ComponentTypeMap,
  Constructor,
  FilterType,
  GuardType,
  InterceptorType,
  MiddlewareType,
  PipeType,
} from '../registry/types';
import type {
  ArgumentMetadata,
  CanActivate,
  ExceptionFilter,
  NestInterceptor,
  NestMiddleware,
  PipeTransform,
} from './types';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Component registration + resolution for the controller/handler tiers.
 * App-wide (global) components have exactly ONE source: the per-app
 * `RouteManager` (`APP_*` provider tokens + `useGlobalX()`) — callers merge
 * `routeManager.getGlobalComponents()` with `getScopedComponents()`
 * (`pipeline/scoped-components.ts`), which adds module-level components.
 *
 * Stateless by design: no process-global container (two apps in one process
 * never cross-talk) — every `resolve*` takes the resolving container.
 */
export class ComponentManager {
  // Scoped registration: controller → handler

  static registerController<T extends ComponentType>(
    type: T,
    controller: Constructor,
    ...components: ComponentTypeMap[T][]
  ): void {
    for (const component of components) {
      MetadataRegistry.registerController(type, controller, component);
    }
  }

  static registerHandler<T extends ComponentType>(
    type: T,
    controller: Constructor,
    handlerName: string | symbol,
    ...components: ComponentTypeMap[T][]
  ): void {
    for (const component of components) {
      MetadataRegistry.registerHandler(type, controller, handlerName, component);
    }
  }

  // Type-specific resolvers — explicit container, always.

  private static resolveAll<T>(
    items: Array<T | Type<T>>,
    methodKey: keyof T & string,
    container: Container,
  ): T[] {
    return items.map((item) =>
      isObject(item) && methodKey in item ? (item as T) : container.resolve(item as Type<T>),
    );
  }

  static resolveMiddleware(items: MiddlewareType[], container: Container): NestMiddleware[] {
    return this.resolveAll<NestMiddleware>(items, 'use', container);
  }

  static resolveGuards(items: GuardType[], container: Container): CanActivate[] {
    return this.resolveAll<CanActivate>(items, 'canActivate', container);
  }

  static resolvePipes(items: PipeType[], container: Container): PipeTransform[] {
    return this.resolveAll<PipeTransform>(items, 'transform', container);
  }

  static resolveInterceptors(items: InterceptorType[], container: Container): NestInterceptor[] {
    return this.resolveAll<NestInterceptor>(items, 'intercept', container);
  }

  static resolveFilters(items: FilterType[], container: Container): ExceptionFilter[] {
    return this.resolveAll<ExceptionFilter>(items, 'catch', container);
  }

  // Pipe execution

  static async executePipes(
    value: unknown,
    metadata: ArgumentMetadata,
    pipes: PipeTransform[],
  ): Promise<unknown> {
    let transformed = value;
    for (const pipe of pipes) {
      transformed = await pipe.transform(transformed, metadata);
    }
    return transformed;
  }
}
