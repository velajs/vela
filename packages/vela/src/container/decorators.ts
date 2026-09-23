import { Scope } from '../constants';
import { MetadataRegistry } from '../registry/metadata.registry';
import type {
  ConstructorDependency,
  InjectableOptions,
  InjectMetadata,
  Token,
  Type,
} from './types';
import { MissingInjectionMetadataError, type ForwardRef } from './types';

export function Injectable(options: InjectableOptions = {}): ClassDecorator {
  return (target: object) => {
    MetadataRegistry.markInjectable(target);
    if (options.scope !== undefined) declareScope(target, options.scope);
  };
}

/**
 * Record a scope that a class decorator received explicitly. Decorators given
 * no scope write nothing and {@link getScope} applies `Scope.DEFAULT` on
 * read, so the result never depends on decorator order. Two different explicit
 * scopes on one class are a wiring error; repeating the same scope is fine.
 */
export function declareScope(target: object, scope: Scope): void {
  const declared = MetadataRegistry.getScope(target);
  if (declared !== undefined && declared !== scope) {
    const name = typeof target === 'function' ? target.name : 'Provider';
    throw new Error(
      `${name} declares conflicting scopes "${declared}" and "${scope}"; declare its scope once.`,
    );
  }
  MetadataRegistry.setScope(target, scope);
}

export function Optional(): ParameterDecorator {
  return (target: object, _propertyKey: string | symbol | undefined, parameterIndex: number) => {
    const existing = getInjectMetadata(target);
    const entry = existing.find((m) => m.index === parameterIndex);
    if (entry) {
      entry.optional = true;
    } else {
      existing.push({ index: parameterIndex, optional: true });
    }
    MetadataRegistry.setInjectTokens(target, existing);
  };
}

export function Inject(token: Token | ForwardRef): ParameterDecorator {
  return (target: object, _propertyKey: string | symbol | undefined, parameterIndex: number) => {
    const existing = getInjectMetadata(target);
    const entry = existing.find((m) => m.index === parameterIndex);
    if (entry) {
      entry.token = token;
    } else {
      existing.push({ index: parameterIndex, token });
    }
    MetadataRegistry.setInjectTokens(target, existing);
  };
}

export function isInjectable(target: object): boolean {
  return MetadataRegistry.hasInjectable(target);
}

export function getScope(target: object): Scope {
  return MetadataRegistry.getScope(target) ?? Scope.DEFAULT;
}

/**
 * Read through Reflect so dist/src coexistence in tests routes through the
 * single polyfill-installed registry — SWC writes `design:paramtypes` via
 * Reflect, so reads must too. Own metadata only: `@Inject`/`@Optional` extend
 * the decorated class's own list, and inheritance is resolved by
 * {@link getConstructorMetadata}. The runtime contract is that each entry is a
 * constructor reference (a `Token`); we surface that contract directly so
 * callers don't need to re-cast.
 */
function getOwnParamTypes(target: object): Array<Token | undefined> | undefined {
  return Reflect.getOwnMetadata('design:paramtypes', target) as
    | Array<Token | undefined>
    | undefined;
}

export function getInjectMetadata(target: object): InjectMetadata[] {
  return MetadataRegistry.getInjectTokens(target) ?? [];
}

export interface ConstructorMetadata {
  paramTypes: ReadonlyArray<Token | undefined>;
  inject: readonly InjectMetadata[];
}

/**
 * Constructor metadata of the nearest class in the prototype chain that
 * declares any: a subclass without its own constructor emits no
 * `design:paramtypes` (TypeScript, SWC and Oxc alike) and inherits its
 * parent's constructor, so it inherits the parent's metadata too. Paramtypes
 * and `@Inject` entries always come from the same class.
 */
export function getConstructorMetadata(target: object): ConstructorMetadata {
  for (
    let current: unknown = target;
    typeof current === 'function' && current !== Function.prototype;
    current = Object.getPrototypeOf(current)
  ) {
    const paramTypes = getOwnParamTypes(current);
    const inject = MetadataRegistry.getInjectTokens(current);
    if (paramTypes !== undefined || inject !== undefined) {
      return { paramTypes: paramTypes ?? [], inject: inject ?? [] };
    }
  }
  return { paramTypes: [], inject: [] };
}

/**
 * Plan a class provider's constructor parameters once, at registration. The
 * resolved arity is the larger of the emitted paramtypes and the highest
 * `@Inject` index (explicit tokens still work in builds that emit no metadata,
 * such as esbuild), and never less than the constructor's declared `length`, so
 * a missing or erased entry fails here rather than constructing the class with
 * `undefined` injected fields. `@Optional()` gaps resolve to `undefined`;
 * `forwardRef` tokens stay unevaluated until resolution.
 */
export function planConstructor(target: Type): ConstructorDependency[] {
  const { paramTypes, inject } = getConstructorMetadata(target);
  const entries = new Map(inject.map((entry) => [entry.index, entry]));
  const arity = Math.max(
    paramTypes.length,
    inject.reduce((max, entry) => Math.max(max, entry.index + 1), 0),
  );
  const declared = Math.max(arity, target.length);

  return Array.from({ length: declared }, (_unused, index): ConstructorDependency => {
    const entry = entries.get(index);
    const optional = entry?.optional === true;
    const explicit = entry?.token;
    if (explicit !== undefined && explicit !== null) return { token: explicit, optional };

    const paramType = paramTypes[index];
    if (paramType !== undefined && !isErasedTypeToken(paramType)) {
      return { token: paramType, optional };
    }
    if (optional) return { optional };

    const reason =
      entry !== undefined && 'token' in entry
        ? 'undefined-inject'
        : index < paramTypes.length
          ? 'erased'
          : 'missing';
    throw new MissingInjectionMetadataError(target.name, index, reason, declared);
  });
}

/**
 * `Object`/nullish at a token position is the fingerprint of a stripped type:
 * an interface, a type-only import, or a circular import at decoration time.
 */
export function isErasedTypeToken(token: unknown): token is ObjectConstructor | null | undefined {
  return token === Object || token === null || token === undefined;
}

/**
 * True when a class decorator ran on `target` (`@Injectable`, `@Controller`,
 * `@Module`, `@Catch`, a gateway, seeder or discoverable decorator). Any of
 * them makes the compiler emit the constructor metadata the container needs.
 */
export function isDecoratedClass(target: Type): boolean {
  if (
    MetadataRegistry.hasInjectable(target) ||
    MetadataRegistry.getModuleOptions(target) !== undefined ||
    MetadataRegistry.hasCatchTypes(target) ||
    MetadataRegistry.getInjectTokens(target) !== undefined ||
    getOwnParamTypes(target) !== undefined
  ) {
    return true;
  }
  for (const key of MetadataRegistry.getCustomClassMetaAll(target)?.keys() ?? []) {
    if (!key.startsWith('design:')) return true;
  }
  return false;
}
