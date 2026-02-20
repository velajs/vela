import 'reflect-metadata';

const SET_METADATA_KEY = 'vela:metadata';

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
      const existing: Map<string, unknown> =
        Reflect.getMetadata(SET_METADATA_KEY, target.constructor, propertyKey) ?? new Map();
      existing.set(key, value);
      Reflect.defineMetadata(SET_METADATA_KEY, existing, target.constructor, propertyKey);
    } else {
      // Class decorator
      const existing: Map<string, unknown> =
        Reflect.getMetadata(SET_METADATA_KEY, target) ?? new Map();
      existing.set(key, value);
      Reflect.defineMetadata(SET_METADATA_KEY, existing, target);
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
   * Get metadata value from handler first, then class.
   * Handler-level metadata takes priority over class-level.
   */
  get<T = unknown>(
    key: string,
    context: { getClass(): Function; getHandler(): string | symbol },
  ): T | undefined {
    // Check handler-level first
    const handlerMeta: Map<string, unknown> | undefined = Reflect.getMetadata(
      SET_METADATA_KEY,
      context.getClass(),
      context.getHandler(),
    );
    if (handlerMeta?.has(key)) {
      return handlerMeta.get(key) as T;
    }

    // Fall back to class-level
    const classMeta: Map<string, unknown> | undefined = Reflect.getMetadata(
      SET_METADATA_KEY,
      context.getClass(),
    );
    if (classMeta?.has(key)) {
      return classMeta.get(key) as T;
    }

    return undefined;
  }

  /**
   * Get metadata only from the handler (method) level.
   */
  getHandler<T = unknown>(
    key: string,
    context: { getClass(): Function; getHandler(): string | symbol },
  ): T | undefined {
    const meta: Map<string, unknown> | undefined = Reflect.getMetadata(
      SET_METADATA_KEY,
      context.getClass(),
      context.getHandler(),
    );
    return meta?.get(key) as T | undefined;
  }

  /**
   * Get metadata only from the class level.
   */
  getClass<T = unknown>(
    key: string,
    context: { getClass(): Function },
  ): T | undefined {
    const meta: Map<string, unknown> | undefined = Reflect.getMetadata(
      SET_METADATA_KEY,
      context.getClass(),
    );
    return meta?.get(key) as T | undefined;
  }

  /**
   * Get all metadata values for a key from both handler and class.
   * Returns [handlerValue, classValue] (either may be undefined).
   */
  getAll<T = unknown>(
    key: string,
    context: { getClass(): Function; getHandler(): string | symbol },
  ): [T | undefined, T | undefined] {
    return [this.getHandler<T>(key, context), this.getClass<T>(key, context)];
  }
}
