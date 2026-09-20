import type { Type } from '../container/types';
import { ComponentManager } from './component.manager';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { ComponentType, ComponentTypeMap, Constructor } from '../registry/types';

function UseComponent<T extends ComponentType>(type: T, ...components: ComponentTypeMap[T][]) {
  return (target: object, propertyKey?: string | symbol) => {
    if (propertyKey !== undefined) {
      ComponentManager.registerHandler(
        type,
        target.constructor as Constructor,
        propertyKey,
        ...components,
      );
    } else {
      ComponentManager.registerController(type, target as Constructor, ...components);
    }
  };
}

export function UseMiddleware(...middleware: ComponentTypeMap['middleware'][]) {
  return UseComponent('middleware', ...middleware);
}

export function UseGuards(...guards: ComponentTypeMap['guard'][]) {
  return UseComponent('guard', ...guards);
}

export function UsePipes(...pipes: ComponentTypeMap['pipe'][]) {
  return UseComponent('pipe', ...pipes);
}

export function UseInterceptors(...interceptors: ComponentTypeMap['interceptor'][]) {
  return UseComponent('interceptor', ...interceptors);
}

export function UseFilters(...filters: ComponentTypeMap['filter'][]) {
  return UseComponent('filter', ...filters);
}

export function Catch(...exceptions: Type<Error>[]): ClassDecorator {
  return (target) => {
    MetadataRegistry.setCatchTypes(target as unknown as Constructor, exceptions);
  };
}

export function getCatchTypes(filter: unknown): Type<Error>[] {
  const filterClass = (
    typeof filter === 'function' ? filter : (filter as object).constructor
  ) as Constructor;
  return MetadataRegistry.getCatchTypes(filterClass) ?? [];
}

export function shouldFilterCatch(filter: unknown, exception: unknown): boolean {
  const catchTypes = getCatchTypes(filter);
  if (catchTypes.length === 0) {
    return true;
  }
  return catchTypes.some((type) => exception instanceof type);
}
