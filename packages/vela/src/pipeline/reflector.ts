import { Injectable } from '../container/decorators';
import { declareRootDefault } from '../container/root-defaults';
import type { Type } from '../container/types';
import { inheritedClassMeta, inheritedHandlerMeta } from '../registry/inherited-metadata';
import {
  MetadataRegistry,
  allocateDecoratorKey,
  type HandlerMethod,
} from '../registry/metadata.registry';
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
        MetadataRegistry.addHandlerMethod(handler, owner, propertyKey);
    } else {
      MetadataRegistry.setCustomClassMeta(target as Constructor, key, value);
    }
  };
}

function resolveKey(key: MetadataKey<unknown>): string {
  return typeof key === 'string' ? key : key.KEY;
}

// Whether `owner` is `target` or one of its ancestors.
function declaresFor(owner: Constructor, target: ReflectorTarget): boolean {
  const prototype: unknown = target.prototype;
  return owner === target || (typeof prototype === 'object' && prototype instanceof owner);
}

// The methods a function target stands for. Alone, every method it was
// recorded as: decorated by SetMetadata, or called by a route. Listed with
// classes, the method each class routes through it (as its own or inherited
// method, or as a subclass of the class that decorated it).
function methodsOf(target: ReflectorTarget, classes: readonly Type[]): HandlerMethod[] {
  const recorded = MetadataRegistry.getHandlerMethods(target);
  if (classes.length === 0) return [...recorded];
  const methods: HandlerMethod[] = [];
  for (const type of classes) {
    for (const [owner, name] of recorded) {
      const routes = Reflect.get(type.prototype, name) === target || declaresFor(owner, type);
      if (routes && !methods.some(([known, method]) => known === type && method === name)) {
        methods.push([type, name]);
      }
    }
  }
  return methods;
}

// A plain array (not a subclass) or a plain object.
function isPlainData(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (Array.isArray(value)) return prototype === Array.prototype;
  return prototype === Object.prototype || prototype === null;
}

// Whether two metadata values are the same plain data: plain arrays and plain
// objects compare own key by own key (an array's indices and length, and any
// other property it carries, such as `requireAll`), anything else by identity.
// Nesting deeper than a metadata value needs counts as different.
function samePlainData(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (depth > 16 || typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b) || !isPlainData(a) || !isPlainData(b)) return false;
  const keys = Reflect.ownKeys(a);
  return (
    keys.length === Reflect.ownKeys(b).length &&
    keys.every(
      (name) =>
        Object.hasOwn(b, name) &&
        samePlainData(Reflect.get(a, name), Reflect.get(b, name), depth + 1),
    )
  );
}

// A handler function reads the metadata of the method it stands for; any other
// function (a class) reads class metadata, its own or its nearest ancestor's,
// as does metadata defined on the function itself. A function that stands for several methods whose metadata
// for `key` differs, such as one inherited method several controllers route
// and decorate differently, or one wrapper function replacing several methods
// of a controller, cannot say which one it serves: the read throws.
function readTarget(target: ReflectorTarget, key: string, classes: readonly Type[] = []): unknown {
  const values: unknown[] = [];
  for (const [type, name] of methodsOf(target, classes)) {
    const value = inheritedHandlerMeta(type, name, key);
    if (!values.some((known) => samePlainData(known, value))) values.push(value);
  }
  if (values.length > 1) {
    throw new Error(
      `Reflector cannot read metadata through the handler function '${target.name}': ` +
        'it stands for several methods with different metadata. Pass the execution ' +
        'context, as in reflector.get(key, context), or, for methods of different ' +
        'controllers, list the controller, as in ' +
        'reflector.getAllAndOverride(key, [context.getHandler(), context.getClass()]).',
    );
  }
  const [value] = values;
  return value ?? inheritedClassMeta(target, key);
}

// A listed class (`[context.getHandler(), context.getClass()]`): a target with
// a prototype, unlike methods, that is not recorded as a handler method.
function isClassTarget(target: ReflectorTarget): target is Type {
  return (
    typeof target.prototype === 'object' && MetadataRegistry.getHandlerMethods(target).length === 0
  );
}

// The routed method's metadata: the controller's own declaration, else that of
// the nearest ancestor whose method the controller inherits unchanged, as the
// function forms read it.
function readHandler(context: ReflectorContext, key: string): unknown {
  return inheritedHandlerMeta(context.getClass(), context.getHandlerName(), key);
}

// The controller's class metadata: its own, else its nearest ancestor's.
function readClass(context: Pick<ExecutionContext, 'getClass'>, key: string): unknown {
  return inheritedClassMeta(context.getClass(), key);
}

function readAll(key: string, targets: ReflectorContext | readonly ReflectorTarget[]): unknown[] {
  if (!Array.isArray(targets)) {
    const context = targets as ReflectorContext;
    return [readHandler(context, key), readClass(context, key)];
  }
  const classes = targets.filter(isClassTarget);
  return targets.map((target: ReflectorTarget) => readTarget(target, key, classes));
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
 * Every form reads a method the controller inherits unchanged with the
 * metadata of its nearest declaration: the controller's own, else the nearest
 * ancestor's; a method the controller overrides reads only its own. Class
 * metadata is inherited the same way, as reflect-metadata resolves it in
 * Nest: the controller's own, else that of the nearest class it extends.
 * A handler function reads the metadata of the method it is: the method a
 * decorator declared it as, or the method a route calls, which an outer
 * decorator may have wrapped. When a list names a class, it reads the method
 * that class routes through the function, so metadata one controller puts on
 * a method it inherits never applies to a sibling controller sharing the
 * method. Alone, a function that several controllers route with different
 * metadata for the key cannot say which one it serves, and the read throws;
 * so does a list naming one controller that routes the function as several
 * methods (one wrapper function replacing them) with different metadata.
 * Plain arrays and plain objects are equal metadata when their own properties
 * are equal, including any non-index property an array carries; any other
 * value is compared by identity.
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
   * // In a guard that injects Reflector: typed as string[] | undefined.
   * // The method's roles, else the class's.
   * const roles = this.reflector.getAllAndOverride(Roles, [
   *   context.getHandler(),
   *   context.getClass(),
   * ]);
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
    return (readHandler(target, resolved) ?? readClass(target, resolved)) as T | undefined;
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
    return readClass(context, resolveKey(key)) as T | undefined;
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
