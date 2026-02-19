import 'reflect-metadata';
import { METADATA_KEYS } from '../constants.js';
import type { Type } from '../container/types.js';
import { ComponentManager } from './component.manager.js';
import type {
  ComponentType,
  ComponentTypeMap,
  Constructor,
} from '../registry/types.js';

function UseComponent<T extends ComponentType>(type: T, ...components: ComponentTypeMap[T][]) {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  return (target: Function | object, propertyKey?: string | symbol) => {
    if (propertyKey !== undefined) {
      // Method decorator — target is prototype, target.constructor is the class
      ComponentManager.registerHandler(
        type,
        target.constructor,
        propertyKey,
        ...components,
      );
    } else {
      // Class decorator — target is the class itself
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
  return (target: object) => {
    Reflect.defineMetadata(METADATA_KEYS.CATCH, exceptions, target);
  };
}

export function getCatchTypes(filter: unknown): Type<Error>[] {
  const filterClass = typeof filter === 'function' ? filter : (filter as object).constructor;
  return Reflect.getMetadata(METADATA_KEYS.CATCH, filterClass) ?? [];
}

export function shouldFilterCatch(filter: unknown, exception: unknown): boolean {
  const catchTypes = getCatchTypes(filter);
  if (catchTypes.length === 0) {
    return true;
  }
  return catchTypes.some((type) => exception instanceof type);
}
