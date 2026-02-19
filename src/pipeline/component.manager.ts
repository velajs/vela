import type { Container } from '../container/container.js';
import type { Type } from '../container/types.js';
import { MetadataRegistry } from '../registry/metadata.registry.js';
import type {
  ComponentType,
  ComponentTypeMap,
  Constructor,
  FilterType,
  GuardType,
  InterceptorType,
  MiddlewareType,
  PipeType,
} from '../registry/types.js';
import type {
  ArgumentMetadata,
  CallHandler,
  CanActivate,
  ExceptionFilter,
  ExecutionContext,
  NestInterceptor,
  NestMiddleware,
  PipeTransform,
} from './types.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class ComponentManager {
  private static container: Container;

  static init(container: Container): void {
    this.container = container;
  }

  // 3-level registration

  static registerGlobal<T extends ComponentType>(
    type: T,
    ...components: ComponentTypeMap[T][]
  ): void {
    for (const component of components) {
      MetadataRegistry.registerGlobal(type, component);
    }
  }

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
    const handlerKey = `${controller.name}:${String(handlerName)}`;
    for (const component of components) {
      MetadataRegistry.registerHandler(type, handlerKey, component);
    }
  }

  // 3-level resolution: global → controller → handler

  static getComponents<T extends ComponentType>(
    type: T,
    controller: Constructor,
    handlerName: string | symbol,
  ): ComponentTypeMap[T][] {
    const handlerKey = `${controller.name}:${String(handlerName)}`;
    const globalComponents = Array.from(MetadataRegistry.getGlobal(type));
    const controllerComponents = MetadataRegistry.getController(type, controller);
    const handlerComponents = MetadataRegistry.getHandler(type, handlerKey);
    return [...globalComponents, ...controllerComponents, ...handlerComponents];
  }

  // Type-specific resolvers

  static resolveMiddleware(items: MiddlewareType[]): NestMiddleware[] {
    return items.map((item) => {
      if (isObject(item) && 'use' in item) {
        return item as NestMiddleware;
      }
      return this.container.resolve(item as Type<NestMiddleware>);
    });
  }

  static resolveGuards(items: GuardType[]): CanActivate[] {
    return items.map((item) => {
      if (isObject(item) && 'canActivate' in item) {
        return item as CanActivate;
      }
      return this.container.resolve(item as Type<CanActivate>);
    });
  }

  static resolvePipes(items: PipeType[]): PipeTransform[] {
    return items.map((item) => {
      if (isObject(item) && 'transform' in item) {
        return item as PipeTransform;
      }
      return this.container.resolve(item as Type<PipeTransform>);
    });
  }

  static resolveInterceptors(items: InterceptorType[]): NestInterceptor[] {
    return items.map((item) => {
      if (isObject(item) && 'intercept' in item) {
        return item as NestInterceptor;
      }
      return this.container.resolve(item as Type<NestInterceptor>);
    });
  }

  static resolveFilters(items: FilterType[]): ExceptionFilter[] {
    return items.map((item) => {
      if (isObject(item) && 'catch' in item) {
        return item as ExceptionFilter;
      }
      return this.container.resolve(item as Type<ExceptionFilter>);
    });
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

  // Interceptor chain (onion pattern)

  static async runInterceptorChain(
    interceptors: NestInterceptor[],
    context: ExecutionContext,
    coreHandler: () => Promise<unknown>,
  ): Promise<unknown> {
    if (interceptors.length === 0) {
      return coreHandler();
    }

    let next: CallHandler = { handle: coreHandler };

    for (let i = interceptors.length - 1; i >= 0; i--) {
      const interceptor = interceptors[i];
      const currentNext = next;
      next = {
        handle: () => interceptor.intercept(context, currentNext),
      };
    }

    return next.handle();
  }
}
