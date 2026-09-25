import { MetadataRegistry } from './metadata.registry';
import type {
  ComponentType,
  ComponentTypeMap,
  Constructor,
  ParameterMetadata,
  RouteDefinition,
} from './types';

// Declarations on an ancestor class apply to the classes that extend it, as
// reflect-metadata resolves them in Nest: class-level declarations along the
// class chain, and method-level ones on a method the class inherits
// unchanged. The registry stores each declaration on the class that made it;
// these readers resolve what applies to a class.

// The class `type` extends, or `undefined` at the root of its chain.
function parentClass(type: unknown): Constructor | undefined {
  const parent: unknown = Object.getPrototypeOf(type);
  return typeof parent === 'function' && parent !== Function.prototype
    ? (parent as Constructor)
    : undefined;
}

// The value `prototype` has, own or inherited, as data property `name`. An
// accessor reads as undefined and is never invoked: on a prototype it may
// throw, as Map.prototype.size does for any receiver that is not a Map.
function methodOf(prototype: unknown, name: string | symbol): unknown {
  for (
    let current = prototype;
    typeof current === 'object' && current !== null;
    current = Object.getPrototypeOf(current)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) return descriptor.value;
  }
  return undefined;
}

/**
 * `type`, then each class it extends, nearest first: the classes whose
 * class-level declarations apply to it.
 */
export function classLineage(type: Constructor): Constructor[] {
  const lineage: Constructor[] = [];
  for (let current: Constructor | undefined = type; current; current = parentClass(current)) {
    lineage.push(current);
  }
  return lineage;
}

/**
 * `type`, then each class it extends whose method `name` is the same function,
 * nearest first: the classes whose declarations on the method apply to it as
 * `type` serves it. A method `type` overrides reads only its own declarations,
 * and so does a name that is not a method (such as a framework host's marker).
 */
export function methodLineage(type: Constructor, name: string | symbol): Constructor[] {
  const lineage = [type];
  const handler = methodOf(type.prototype, name);
  if (typeof handler !== 'function') return lineage;
  for (let current = parentClass(type); current; current = parentClass(current)) {
    if (methodOf(current.prototype, name) !== handler) break;
    lineage.push(current);
  }
  return lineage;
}

/**
 * Class metadata that applies to `type`: its own, else its nearest ancestor's.
 * A function that is not a class reads its own.
 */
export function inheritedClassMeta(type: object, key: string): unknown {
  for (let current: object | undefined = type; current; current = parentClass(current)) {
    const value = MetadataRegistry.getCustomClassMeta(current, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Metadata of method `name` as `type` serves it: its own declaration, else
 * that of the nearest ancestor whose method it inherits unchanged.
 */
export function inheritedHandlerMeta(
  type: Constructor,
  name: string | symbol,
  key: string,
): unknown {
  for (const owner of methodLineage(type, name)) {
    const value = MetadataRegistry.getCustomHandlerMeta(owner, name, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * The routes `type` declares. A route without options of its own, serving a
 * method `type` inherits unchanged, takes the options (or `defineRoute`
 * contract) of the nearest ancestor's route for the same verb and method.
 */
export function inheritedRoutes(type: Constructor): RouteDefinition[] {
  return MetadataRegistry.getRoutes(type).map((route) => {
    if (route.contract) return route;
    for (const owner of methodLineage(type, route.handlerName).slice(1)) {
      const declared = MetadataRegistry.getRoutes(owner).find(
        (candidate) =>
          candidate.contract &&
          candidate.handlerName === route.handlerName &&
          candidate.method === route.method,
      );
      if (declared) return { ...route, contract: declared.contract };
    }
    return route;
  });
}

/**
 * The parameter declarations of method `name` as `type` serves it: its own,
 * else those of the nearest ancestor whose method it inherits unchanged.
 */
export function inheritedParameters(type: Constructor, name: string | symbol): ParameterMetadata[] {
  for (const owner of methodLineage(type, name)) {
    const parameters = MetadataRegistry.getParameters(owner).get(name);
    if (parameters?.length) return parameters;
  }
  return [];
}

/**
 * The emitted parameter types (`design:paramtypes`) of method `name` as
 * `type` serves it, from the nearest class in its method lineage that has them.
 */
export function inheritedParamTypes(
  type: Constructor,
  name: string | symbol,
): unknown[] | undefined {
  for (const owner of methodLineage(type, name)) {
    const types: unknown = Reflect.getMetadata('design:paramtypes', owner.prototype, name);
    if (Array.isArray(types)) return types;
  }
  return undefined;
}

/** The class-level components of `type` and its ancestors, the root class's first. */
export function inheritedClassComponents<T extends ComponentType>(
  type: T,
  target: Constructor,
): ComponentTypeMap[T][] {
  return classLineage(target)
    .toReversed()
    .flatMap((owner) => MetadataRegistry.getController(type, owner));
}

/**
 * The method-level components of method `name` as `target` serves it: those
 * each ancestor declares on the method `target` inherits unchanged, the
 * farthest ancestor's first, then its own.
 */
export function inheritedHandlerComponents<T extends ComponentType>(
  type: T,
  target: Constructor,
  name: string | symbol,
): ComponentTypeMap[T][] {
  return methodLineage(target, name)
    .toReversed()
    .flatMap((owner) => MetadataRegistry.getHandler(type, owner, name));
}

/**
 * The components an ancestor of `target` declares that apply to `target`: at
 * class level, and on each method `target` inherits unchanged.
 */
export function ancestorComponents<T extends ComponentType>(
  type: T,
  target: Constructor,
): ComponentTypeMap[T][] {
  const [, ...ancestors] = classLineage(target);
  const components = ancestors.flatMap((owner) => MetadataRegistry.getController(type, owner));
  const names = new Set(
    ancestors.flatMap((owner) => {
      const prototype: unknown = owner.prototype;
      return typeof prototype === 'object' && prototype !== null ? Reflect.ownKeys(prototype) : [];
    }),
  );
  for (const name of names) {
    for (const owner of methodLineage(target, name).slice(1)) {
      components.push(...MetadataRegistry.getHandler(type, owner, name));
    }
  }
  return components;
}
