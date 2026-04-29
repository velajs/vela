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
  CallHandler,
  CanActivate,
  ExceptionFilter,
  ExecutionContext,
  NestInterceptor,
  NestMiddleware,
  PipeTransform,
} from './types';

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
    for (const component of components) {
      MetadataRegistry.registerHandler(type, controller, handlerName, component);
    }
  }

  // 3-level resolution: global → controller → handler

  static getComponents<T extends ComponentType>(
    type: T,
    controller: Constructor,
    handlerName: string | symbol,
  ): ComponentTypeMap[T][] {
    const controllerComponents = MetadataRegistry.getController(type, controller);
    const handlerComponents = MetadataRegistry.getHandler(type, controller, handlerName);
    return [...MetadataRegistry.getGlobal(type), ...controllerComponents, ...handlerComponents];
  }

  // Type-specific resolvers

  private static resolveAll<T>(items: Array<T | Type<T>>, methodKey: keyof T & string): T[] {
    return items.map((item) =>
      isObject(item) && methodKey in item ? (item as T) : this.container.resolve(item as Type<T>),
    );
  }

  static resolveMiddleware(items: MiddlewareType[]): NestMiddleware[] {
    return this.resolveAll<NestMiddleware>(items, 'use');
  }

  static resolveGuards(items: GuardType[]): CanActivate[] {
    return this.resolveAll<CanActivate>(items, 'canActivate');
  }

  static resolvePipes(items: PipeType[]): PipeTransform[] {
    return this.resolveAll<PipeTransform>(items, 'transform');
  }

  static resolveInterceptors(items: InterceptorType[]): NestInterceptor[] {
    return this.resolveAll<NestInterceptor>(items, 'intercept');
  }

  static resolveFilters(items: FilterType[]): ExceptionFilter[] {
    return this.resolveAll<ExceptionFilter>(items, 'catch');
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
