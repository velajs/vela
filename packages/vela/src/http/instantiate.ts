import { isErasedTypeToken, planConstructor } from '../container/decorators';
import type { Container } from '../container/container';
import type { ConstructorDependency, Token, TypedToken, Type } from '../container/types';
import {
  ForwardRef,
  InjectionToken,
  MissingInjectionMetadataError,
  describeToken,
} from '../container/types';

// Resolve a class/token through the container if registered, otherwise treat
// the input as a plain instance. Used by RouteManager, HandlerExecutor and the
// other dispatchers to materialize middleware, guards, pipes, interceptors,
// and filters. The module loader registers every guard, pipe, interceptor and
// filter class a module's classes reference in `@Use*` or parameter
// decorators, so those resolve through the container from their module, once
// per scope, like any provider.
//
// A class that is NOT registered anywhere (an `app.useGlobalGuards(Class)`
// entry, a hand-built container) falls back to `new clazz()` so plain
// parameterless helper classes keep working. That fallback is unsafe for
// classes whose CONSTRUCTOR EXPECTS DEPENDENCIES, because zero-arg
// construction would leave every injected slot `undefined` — a silent failure
// mode that surfaces later deep inside the class. For those classes we throw
// a loud, actionable error instead.
//
// We treat "expects dependencies" as: the planned constructor has a parameter
// that is not `@Optional()` (an `@Inject(...)` token or an emitted
// `design:paramtypes` entry). `@Injectable()` alone is NOT sufficient —
// `mixin()` and many parameterless guards are `@Injectable()` and still safe to
// `new` directly, as is a class whose only parameters are `@Optional()` slots
// WITHOUT a token, such as `ValidationPipe`'s erased schema parameter.
//
// An `@Optional()` slot that DOES carry a token must not be skipped: the token
// may be registered and visible, and a guard that falls back when its policy
// is missing would fail open. The async path constructs such a class through
// the container from the requesting module (a transient, caller-owned
// instance); the synchronous path cannot resolve async providers, so it throws.
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
    const optionalToken = unregisteredOptionalToken(clazz);
    if (optionalToken !== undefined) {
      throw new Error(
        `Cannot instantiate ${clazz.name} synchronously: its @Optional() parameter injects ` +
          `${describeToken(optionalToken)}, which \`new\` would skip. Add it to a module's ` +
          'providers, or resolve it asynchronously.',
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

// The fallback plan for a class that is not registered in the container. It
// throws when `new clazz()` would leave a required injected slot `undefined`:
// the container's own constructor plan (including the metadata a subclass
// inherits with its parent's constructor) has a non-optional parameter, or no
// usable plan exists at all. Otherwise it returns the token of the first
// `@Optional()` slot that names one, which only the container can resolve, or
// undefined when every slot is a tokenless optional and `new()` is safe.
function unregisteredOptionalToken(clazz: Type<unknown>): Token | undefined {
  let dependencies: ConstructorDependency[];
  try {
    dependencies = planConstructor(clazz);
  } catch (error) {
    if (error instanceof MissingInjectionMetadataError) throw missingProviderError(clazz);
    throw error;
  }
  if (dependencies.some((dependency) => !dependency.optional)) throw missingProviderError(clazz);
  for (const { token: raw } of dependencies) {
    const token = raw instanceof ForwardRef ? raw.factory() : raw;
    if (!isErasedTypeToken(token)) return token;
  }
  return undefined;
}

function missingProviderError(clazz: Type<unknown>): Error {
  return new Error(
    `Cannot instantiate ${clazz.name}: it declares constructor dependencies but is not ` +
      "registered as a provider, and `new` would leave them undefined. Add it to a module's " +
      'providers.',
  );
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
  if (typeof classOrInstance === 'function') {
    const clazz = classOrInstance as Type;
    if (container.has(clazz)) return container.resolveAsync(clazz, moduleId);
    // An optional slot with a token resolves through the container, from the
    // requesting module, so a registered and visible token is never skipped.
    if (unregisteredOptionalToken(clazz) !== undefined) return container.construct(clazz, moduleId);
    return new clazz();
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
