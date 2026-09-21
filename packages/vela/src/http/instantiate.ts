import { getConstructorDependencies, getInjectMetadata } from '../container/decorators';
import type { Container } from '../container/container';
import type { TypedToken, Type } from '../container/types';
import { InjectionToken } from '../container/types';

// Resolve a class/token through the container if registered, otherwise treat
// the input as a plain instance. Used by RouteManager and HandlerExecutor to
// materialize middleware, guards, pipes, interceptors, and filters per request.
//
// When the input is a class that is NOT registered in the container, we fall
// back to `new clazz()` so plain parameterless helper classes (e.g. mixin
// guards, ad-hoc `@UseGuards(LocalGuard)` references) keep working. That
// fallback is unsafe for classes whose CONSTRUCTOR EXPECTS DEPENDENCIES,
// because zero-arg construction would leave every injected slot `undefined`
// — a silent failure mode that surfaces later as
// `Cannot read properties of undefined (reading '...')` deep inside the
// class. For those classes we throw a loud, actionable error instead.
//
// We treat "expects dependencies" as: any `@Inject(...)` parameter metadata
// OR a non-empty `design:paramtypes` (the SWC/TS emit for any constructor
// parameter). `@Injectable()` alone is NOT sufficient — `mixin()` and many
// parameterless guards are `@Injectable()` and still safe to `new` directly.
export function instantiate<T>(
  classOrInstance: Type<T> | TypedToken<T> | T,
  container: Container,
  moduleId?: string,
): T;
export function instantiate(
  classOrInstance: unknown,
  container: Container,
  moduleId?: string,
): unknown {
  if (typeof classOrInstance === 'function') {
    const clazz = classOrInstance as Type;
    if (container.has(clazz)) {
      return container.resolve(clazz, moduleId);
    }
    if (constructorExpectsDependencies(clazz)) {
      throw new Error(
        `Cannot instantiate ${clazz.name}: the class declares constructor ` +
          `dependencies (\`@Inject(...)\` parameters or typed constructor ` +
          `parameters), but no matching provider is registered in the ` +
          `container. Add it to a module's providers (and export it if used ` +
          `outside its declaring module) instead of relying on the bare ` +
          `\`new\` fallback, which would construct the class without ` +
          `honouring its dependency-injection metadata and leave every ` +
          `injected field \`undefined\`.`,
      );
    }
    return new clazz();
  }

  if (
    typeof classOrInstance === 'string' ||
    typeof classOrInstance === 'symbol' ||
    classOrInstance instanceof InjectionToken
  ) {
    return container.resolve(classOrInstance, moduleId);
  }

  return classOrInstance;
}

// True when calling `new clazz()` would leave an injected slot `undefined`:
// either the class has explicit `@Inject(...)` metadata, or it has any typed
// constructor parameter (TS/SWC's `design:paramtypes` emit). Parameterless
// `@Injectable()` classes return false — `new()` is safe for them.
function constructorExpectsDependencies(clazz: Type<unknown>): boolean {
  if (getInjectMetadata(clazz).length > 0) return true;
  return getConstructorDependencies(clazz).length > 0;
}

export function instantiateMany<T>(
  items: readonly (Type<T> | TypedToken<T> | T)[],
  container: Container,
  moduleId?: string,
): T[] {
  return items.map((item) => instantiate(item, container, moduleId));
}

/** Async DI counterpart with the same explicit-instance and safe helper fallbacks. */
export function instantiateAsync<T>(
  classOrInstance: Type<T> | TypedToken<T> | T,
  container: Container,
  moduleId?: string,
): Promise<T>;
export async function instantiateAsync(
  classOrInstance: unknown,
  container: Container,
  moduleId?: string,
): Promise<unknown> {
  if (typeof classOrInstance === 'function' && container.has(classOrInstance as Type)) {
    return container.resolveAsync(classOrInstance as Type, moduleId);
  }
  if (
    typeof classOrInstance === 'string' ||
    typeof classOrInstance === 'symbol' ||
    classOrInstance instanceof InjectionToken
  ) {
    return container.resolveAsync(classOrInstance, moduleId);
  }
  return instantiate(classOrInstance, container, moduleId);
}

/** Preserve declaration order and stop construction at the first failed component. */
export async function instantiateManyAsync<T>(
  items: readonly (Type<T> | TypedToken<T> | T)[],
  container: Container,
  moduleId?: string,
): Promise<T[]> {
  const resolved: T[] = [];
  for (const item of items) resolved.push(await instantiateAsync(item, container, moduleId));
  return resolved;
}
