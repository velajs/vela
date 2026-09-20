import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor } from '../registry/types';
import type { ExecutionContext } from './types';

export interface CreateDecoratorOptions {
  key?: string;
}

export interface ReflectableDecorator<TParam> {
  (value: TParam): ClassDecorator & MethodDecorator;
  KEY: string;
}

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
  return (target: object, propertyKey?: string | symbol) => {
    if (propertyKey !== undefined) {
      MetadataRegistry.setCustomHandlerMeta(
        target.constructor as Constructor,
        propertyKey,
        key,
        value,
      );
    } else {
      MetadataRegistry.setCustomClassMeta(target as Constructor, key, value);
    }
  };
}

/**
 * Reads custom metadata set by @SetMetadata().
 * Use in guards/interceptors via ExecutionContext.
 *
 * @example
 * ```ts
 * class RolesGuard implements CanActivate {
 *   private reflector = new Reflector();
 *
 *   canActivate(context: ExecutionContext): boolean {
 *     const roles = this.reflector.get<string[]>('roles', context);
 *     if (!roles) return true;
 *     const user = ...; // extract from request
 *     return roles.some(r => user.roles.includes(r));
 *   }
 * }
 * ```
 */
export class Reflector {
  /**
   * Create a type-safe decorator that sets metadata with a typed key.
   *
   * @example
   * ```ts
   * const Roles = Reflector.createDecorator<string[]>();
   * // Roles(['admin']) — class or method decorator
   * // reflector.get(Roles, context) — typed as string[] | undefined
   * ```
   */
  static createDecorator<TParam = unknown>(
    options?: CreateDecoratorOptions,
  ): ReflectableDecorator<TParam> {
    const key = options?.key ?? `vela:custom:${crypto.randomUUID()}`;
    const decorator = (value: TParam) => SetMetadata(key, value);
    (decorator as ReflectableDecorator<TParam>).KEY = key;
    return decorator as ReflectableDecorator<TParam>;
  }

  private resolveKey(keyOrDecorator: string | ReflectableDecorator<unknown>): string {
    return typeof keyOrDecorator === 'string' ? keyOrDecorator : keyOrDecorator.KEY;
  }

  /**
   * Get metadata value from handler first, then class.
   * Handler-level metadata takes priority over class-level.
   */
  get<T = unknown>(
    key: string | ReflectableDecorator<T>,
    context: ExecutionContext,
  ): T | undefined {
    const resolvedKey = this.resolveKey(key as string | ReflectableDecorator<unknown>);
    const ctor = context.getClass();
    const handlerValue = MetadataRegistry.getCustomHandlerMeta(
      ctor,
      context.getHandler(),
      resolvedKey,
    );
    if (handlerValue !== undefined) return handlerValue as T;
    return MetadataRegistry.getCustomClassMeta(ctor, resolvedKey) as T | undefined;
  }

  /**
   * Get metadata only from the handler (method) level.
   */
  getHandler<T = unknown>(
    key: string | ReflectableDecorator<T>,
    context: ExecutionContext,
  ): T | undefined {
    const resolvedKey = this.resolveKey(key as string | ReflectableDecorator<unknown>);
    return MetadataRegistry.getCustomHandlerMeta(
      context.getClass(),
      context.getHandler(),
      resolvedKey,
    ) as T | undefined;
  }

  /**
   * Get metadata only from the class level.
   */
  getClass<T = unknown>(
    key: string | ReflectableDecorator<T>,
    context: Pick<ExecutionContext, 'getClass'>,
  ): T | undefined {
    const resolvedKey = this.resolveKey(key as string | ReflectableDecorator<unknown>);
    return MetadataRegistry.getCustomClassMeta(context.getClass(), resolvedKey) as T | undefined;
  }

  /**
   * Get all metadata values for a key from both handler and class.
   * Returns [handlerValue, classValue] (either may be undefined).
   */
  getAll<T = unknown>(
    key: string | ReflectableDecorator<T>,
    context: ExecutionContext,
  ): [T | undefined, T | undefined] {
    return [this.getHandler<T>(key, context), this.getClass<T>(key, context)];
  }

  /**
   * Returns handler value if defined, else class value, else undefined.
   * First defined value wins.
   */
  getAllAndOverride<T = unknown>(
    key: string | ReflectableDecorator<T>,
    context: ExecutionContext,
  ): T | undefined {
    return this.getHandler<T>(key, context) ?? this.getClass<T>(key, context);
  }

  /**
   * Collects handler + class values, filters undefineds.
   * - 0 values → []
   * - 1 value → return it
   * - Arrays → concatenate
   * - Objects → Object.assign({}, ...values)
   * - Otherwise → wrap in array
   */
  getAllAndMerge<T = unknown>(
    key: string | ReflectableDecorator<T>,
    context: ExecutionContext,
  ): T | T[] {
    const [handlerValue, classValue] = this.getAll<T>(key, context);
    const values: T[] = [];
    if (handlerValue !== undefined) values.push(handlerValue);
    if (classValue !== undefined) values.push(classValue);

    if (values.length === 0) return [] as T[];
    if (values.length === 1) return values[0]!;

    if (Array.isArray(values[0]) && Array.isArray(values[1])) {
      return [...values[0], ...values[1]] as T;
    }
    if (
      typeof values[0] === 'object' &&
      values[0] !== null &&
      !Array.isArray(values[0]) &&
      typeof values[1] === 'object' &&
      values[1] !== null &&
      !Array.isArray(values[1])
    ) {
      return Object.assign({}, values[0], values[1]) as T;
    }

    return values;
  }
}
