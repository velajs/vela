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
        `Cannot instantiate ${clazz.name} synchronously: its \`@Optional()\` constructor ` +
          `parameter injects ${describeToken(optionalToken)}, which a bare \`new\` would skip ` +
          `even when it is registered. Add it to a module's providers (and export it if used ` +
          `outside its declaring module), or resolve it asynchronously.`,
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
