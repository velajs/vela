import { Injectable } from '../container/decorators';
import { declareRootDefault } from '../container/root-defaults';
import type { Type } from '../container/types';
import { MetadataRegistry, allocateDecoratorKey } from '../registry/metadata.registry';
import type { Constructor } from '../registry/types';
import type { ExecutionContext, HandlerFunction } from './types';

export interface CreateDecoratorOptions<TParam = unknown, TTransformed = TParam> {
  /** Metadata key. Defaults to a process-unique key. */
  key?: string;
  /** Maps the decorator argument to the stored value readers receive. */
  transform?: (value: TParam) => TTransformed;
}

export interface ReflectableDecorator<TParam, TTransformed = TParam> {
  (value: TParam): ClassDecorator & MethodDecorator;
  readonly KEY: string;
  /** Type-only: the value readers receive. Never present at runtime. */
  readonly '~value'?: TTransformed;
}

/** A class or a handler function, as returned by `getClass()` and `getHandler()`. */
export type ReflectorTarget = Type | HandlerFunction;

/** The execution context members the Reflector reads (handler first, then class). */
export type ReflectorContext = Pick<ExecutionContext, 'getClass' | 'getHandlerName'>;

type MetadataKey<T> = string | ReflectableDecorator<never, T>;

/**
 * Decorator that attaches custom metadata to a class or method.
 * Read via Reflector in guards/interceptors.
 *
 * @example
 * ```ts
 * const Roles = (...roles: string[]) => SetMetadata('roles', roles);
 *
 * @Controller('/admin')
 * @Roles('admin')
 * class AdminController { ... }
 * ```
 */
export function SetMetadata<V = unknown>(key: string, value: V) {
  return (target: object, propertyKey?: string | symbol, descriptor?: PropertyDescriptor) => {
    if (propertyKey !== undefined) {
      const owner = target.constructor as Constructor;
      MetadataRegistry.setCustomHandlerMeta(owner, propertyKey, key, value);
      // `reflector.get(key, context.getHandler())` reads through the function.
      const handler: unknown = descriptor?.value ?? Reflect.get(target, propertyKey);
      if (typeof handler === 'function')
        MetadataRegistry.setHandlerOwner(handler, owner, propertyKey);
    } else {
      MetadataRegistry.setCustomClassMeta(target as Constructor, key, value);
    }
  };
}

function resolveKey(key: MetadataKey<unknown>): string {
  return typeof key === 'string' ? key : key.KEY;
}

// A handler function reads its declaring method's metadata; any other function
// (a class) reads class metadata, as does metadata defined on the function itself.
function readTarget(target: ReflectorTarget, key: string): unknown {
  const owner = MetadataRegistry.getHandlerOwner(target);
  const value = owner ? MetadataRegistry.getCustomHandlerMeta(owner[0], owner[1], key) : undefined;
  return value ?? MetadataRegistry.getCustomClassMeta(target, key);
}

function readHandler(context: ReflectorContext, key: string): unknown {
  return MetadataRegistry.getCustomHandlerMeta(context.getClass(), context.getHandlerName(), key);
}

function readAll(key: string, targets: ReflectorContext | readonly ReflectorTarget[]): unknown[] {
  return Array.isArray(targets)
    ? targets.map((target: ReflectorTarget) => readTarget(target, key))
    : [
        readHandler(targets as ReflectorContext, key),
        MetadataRegistry.getCustomClassMeta((targets as ReflectorContext).getClass(), key),
      ];
}

/**
 * Reads custom metadata set by `@SetMetadata()` or a decorator from
 * `Reflector.createDecorator()`. Every application provides it globally, so
 * guards and interceptors inject it like any provider.
 *
 * Each reader takes an `ExecutionContext` (handler metadata first, then
 * class), or Nest's targets: `get(key, context.getHandler())`,
 * `get(key, context.getClass())` and
 * `getAllAndOverride(key, [context.getHandler(), context.getClass()])`.
 *
 * @example
 * ```ts
 * @Injectable()
 * class RolesGuard implements CanActivate {
 *   constructor(private readonly reflector: Reflector) {}
 *
 *   canActivate(context: ExecutionContext): boolean {
 *     const roles = this.reflector.getAllAndOverride(Roles, [
 *       context.getHandler(),
 *       context.getClass(),
 *     ]);
 *     if (!roles) return true;
 *     const user = ...; // extract from request
 *     return roles.some(r => user.roles.includes(r));
 *   }
 * }
 * ```
 */
@Injectable()
export class Reflector {
  /**
   * Create a type-safe decorator that sets metadata with a typed key.
   * Without `options.key`, the key is allocated from a process-wide counter,
   * so declaring decorators at module scope is safe on Workers too.
   * `options.transform` maps the argument to the stored value.
   *
   * @example
   * ```ts
   * const Roles = Reflector.createDecorator<string[]>();
   *
   * @Roles(['admin']) // class or method decorator
   * @Controller('/admin')
   * class AdminController {}
   *
   * // In a guard that injects Reflector: typed as string[] | undefined
   * const roles = this.reflector.get(Roles, context.getHandler());
   * ```
   */
  static createDecorator<TParam = unknown, TTransformed = TParam>(
    options?: CreateDecoratorOptions<TParam, TTransformed>,
  ): ReflectableDecorator<TParam, TTransformed> {
    const key = options?.key ?? allocateDecoratorKey();
    const transform = options?.transform;
    const decorator = (value: TParam) =>
      SetMetadata(key, transform ? transform(value) : value) as ClassDecorator & MethodDecorator;
    return Object.assign(decorator, { KEY: key });
  }

  /**
   * Metadata for one target. With an execution context, handler metadata
   * takes priority over class metadata.
   */
  get<T = unknown>(key: MetadataKey<T>, target: ReflectorContext | ReflectorTarget): T | undefined {
    const resolved = resolveKey(key);
    if (typeof target === 'function') return readTarget(target, resolved) as T | undefined;
    return (readHandler(target, resolved) ??
      MetadataRegistry.getCustomClassMeta(target.getClass(), resolved)) as T | undefined;
  }

  /** Metadata from the handler (method) level only. */
  getHandler<T = unknown>(key: MetadataKey<T>, context: ReflectorContext): T | undefined {
    return readHandler(context, resolveKey(key)) as T | undefined;
  }

  /** Metadata from the class level only. */
  getClass<T = unknown>(
    key: MetadataKey<T>,
    context: Pick<ExecutionContext, 'getClass'>,
  ): T | undefined {
    return MetadataRegistry.getCustomClassMeta(context.getClass(), resolveKey(key)) as
      | T
      | undefined;
  }

  /**
   * Metadata for each target in order, or `[handler, class]` for an
   * execution context. Missing values are `undefined`.
   */
  getAll<T = unknown>(
    key: MetadataKey<T>,
    targets: ReflectorContext | readonly ReflectorTarget[],
  ): Array<T | undefined> {
    return readAll(resolveKey(key), targets) as Array<T | undefined>;
  }

  /** The first defined value across the targets (handler, then class for a context). */
  getAllAndOverride<T = unknown>(
    key: MetadataKey<T>,
    targets: ReflectorContext | readonly ReflectorTarget[],
  ): T | undefined {
    return this.getAll<T>(key, targets).find((value) => value !== undefined);
  }

  /**
   * Collects the defined values across the targets:
   * - 0 values → []
   * - 1 value → return it
   * - Arrays → concatenate
   * - Objects → Object.assign({}, ...values)
   * - Otherwise → the values as an array
   */
  getAllAndMerge<T = unknown>(
    key: MetadataKey<T>,
    targets: ReflectorContext | readonly ReflectorTarget[],
  ): T | T[] {
    const values = this.getAll<T>(key, targets).filter((value) => value !== undefined);
    if (values.length === 0) return [];
    if (values.length === 1) return values[0]!;
    if (values.every((value) => Array.isArray(value))) return values.flat() as T;
    if (
      values.every((value) => typeof value === 'object' && value !== null && !Array.isArray(value))
    ) {
      return Object.assign({}, ...values) as T;
    }
    return values;
  }
}

// Injectable from any module, as in Nest.
declareRootDefault(Reflector);
