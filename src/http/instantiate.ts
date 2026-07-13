import { getConstructorDependencies, getInjectMetadata } from '../container/decorators';
import type { Container } from '../container/container';
import type { Token, Type } from '../container/types';

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
export function instantiate<T>(classOrInstance: Type<T> | Token<T> | T, container: Container): T {
  if (typeof classOrInstance === 'function') {
    const clazz = classOrInstance as Type<T>;
    if (container.has(clazz)) {
      return container.resolve(clazz);
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

  if (container.has(classOrInstance as Token<T>)) {
    return container.resolve(classOrInstance as Token<T>);
  }

  return classOrInstance as T;
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
  items: Array<Type<T> | Token<T> | T>,
  container: Container,
): T[] {
  return items.map((item) => instantiate(item, container));
}
