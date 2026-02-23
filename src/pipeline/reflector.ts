import { getMetadata as internalGetMetadata } from '../metadata';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor } from '../registry/types';

const SET_METADATA_KEY = 'vela:metadata';

export interface CreateDecoratorOptions {
  key?: string;
}

export interface ReflectableDecorator<TParam> {
  (value: TParam): ClassDecorator & MethodDecorator;
  KEY: string;
}

let _decoratorKeyCounter = 0;

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
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  return (target: Function | object, propertyKey?: string | symbol) => {
    if (propertyKey !== undefined) {
      // Method decorator
      MetadataRegistry.setCustomHandlerMeta(
        target.constructor as Constructor,
        propertyKey,
        key,
        value,
      );
    } else {
      // Class decorator
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
    const key = options?.key ?? `vela:custom:${_decoratorKeyCounter++}`;
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
    context: { getClass(): Function; getHandler(): string | symbol },
  ): T | undefined {
    const resolvedKey = this.resolveKey(key as string | ReflectableDecorator<unknown>);

    // Check handler-level first (MetadataRegistry)
    const handlerValue = MetadataRegistry.getCustomHandlerMeta(
      context.getClass() as Constructor,
      context.getHandler(),
      resolvedKey,
    );
    if (handlerValue !== undefined) {
      return handlerValue as T;
    }

    // Check class-level (MetadataRegistry)
    const classValue = MetadataRegistry.getCustomClassMeta(
      context.getClass() as Constructor,
      resolvedKey,
    );
    if (classValue !== undefined) {
      return classValue as T;
    }

    // Fallback to WeakMap for external package compat
    const handlerMeta: Map<string, unknown> | undefined = internalGetMetadata(
      SET_METADATA_KEY,
      context.getClass(),
      context.getHandler(),
    ) as Map<string, unknown> | undefined;
    if (handlerMeta?.has(resolvedKey)) {
      return handlerMeta.get(resolvedKey) as T;
    }

    const classMeta: Map<string, unknown> | undefined = internalGetMetadata(
      SET_METADATA_KEY,
      context.getClass(),
    ) as Map<string, unknown> | undefined;
    if (classMeta?.has(resolvedKey)) {
      return classMeta.get(resolvedKey) as T;
    }

    return undefined;
  }

  /**
   * Get metadata only from the handler (method) level.
   */
  getHandler<T = unknown>(
    key: string | ReflectableDecorator<T>,
    context: { getClass(): Function; getHandler(): string | symbol },
  ): T | undefined {
    const resolvedKey = this.resolveKey(key as string | ReflectableDecorator<unknown>);

    // MetadataRegistry first
    const value = MetadataRegistry.getCustomHandlerMeta(
      context.getClass() as Constructor,
      context.getHandler(),
      resolvedKey,
    );
    if (value !== undefined) {
      return value as T;
    }

    // Fallback to WeakMap
    const meta: Map<string, unknown> | undefined = internalGetMetadata(
      SET_METADATA_KEY,
      context.getClass(),
      context.getHandler(),
    ) as Map<string, unknown> | undefined;
    return meta?.get(resolvedKey) as T | undefined;
  }

  /**
   * Get metadata only from the class level.
   */
  getClass<T = unknown>(
    key: string | ReflectableDecorator<T>,
    context: { getClass(): Function },
  ): T | undefined {
    const resolvedKey = this.resolveKey(key as string | ReflectableDecorator<unknown>);

    // MetadataRegistry first
    const value = MetadataRegistry.getCustomClassMeta(
      context.getClass() as Constructor,
      resolvedKey,
    );
    if (value !== undefined) {
      return value as T;
    }

    // Fallback to WeakMap
    const meta: Map<string, unknown> | undefined = internalGetMetadata(
      SET_METADATA_KEY,
      context.getClass(),
    ) as Map<string, unknown> | undefined;
    return meta?.get(resolvedKey) as T | undefined;
  }

  /**
   * Get all metadata values for a key from both handler and class.
   * Returns [handlerValue, classValue] (either may be undefined).
   */
  getAll<T = unknown>(
    key: string | ReflectableDecorator<T>,
    context: { getClass(): Function; getHandler(): string | symbol },
  ): [T | undefined, T | undefined] {
    return [this.getHandler<T>(key, context), this.getClass<T>(key, context)];
  }

  /**
   * Returns handler value if defined, else class value, else undefined.
   * First defined value wins.
   */
  getAllAndOverride<T = unknown>(
    key: string | ReflectableDecorator<T>,
    context: { getClass(): Function; getHandler(): string | symbol },
  ): T | undefined {
    const handlerValue = this.getHandler<T>(key, context);
    if (handlerValue !== undefined) {
      return handlerValue;
    }
    return this.getClass<T>(key, context);
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
    context: { getClass(): Function; getHandler(): string | symbol },
  ): T | T[] {
    const [handlerValue, classValue] = this.getAll<T>(key, context);
    const values: T[] = [];
    if (handlerValue !== undefined) values.push(handlerValue);
    if (classValue !== undefined) values.push(classValue);

    if (values.length === 0) {
      return [] as T[];
    }
    if (values.length === 1) {
      return values[0];
    }

    // Both defined — merge strategy depends on type
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
