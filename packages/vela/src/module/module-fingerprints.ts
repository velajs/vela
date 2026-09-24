import { getProviderOptions, isProviderDefinition } from '../container/types';
import type { DynamicModule } from '../registry/types';
import {
  MODULE_IDENTITY,
  isDynamicModule,
  moduleKeyOf,
  readModuleIdentity,
  type ModuleIdentity,
  type ModuleIdentityComparer,
} from './module-identity';

// A new comparer per module loader: its reference ids must never outlive it.
const createComparer = (): ModuleIdentityComparer => new ModuleIdentityFingerprints();

/**
 * @internal Record the inputs a generated DynamicModule was built from
 * (`defineModule`, `sideEffectModule`, `ConfigModule`), so the
 * loader can tell a repeated identical import from a conflicting one.
 */
export function attachModuleIdentity<T extends DynamicModule>(definition: T, inputs: unknown): T {
  if (Object.isExtensible(definition)) {
    const identity: ModuleIdentity = { inputs, createComparer };
    Object.defineProperty(definition, MODULE_IDENTITY, {
      value: Object.freeze(identity),
      enumerable: false,
    });
  }
  return definition;
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Compares module identity inputs for ONE module loader. Values compare
 * structurally; functions, symbols and class instances compare by reference,
 * through ids this instance hands out. Source text cannot see what a closure
 * captured, so two closures with the same source (a parameterized helper
 * called with different arguments) are different inputs. The ids are owned by
 * the loader (never the process), so they are released with it and cannot
 * leak across applications. Fingerprints are only built for repeated imports,
 * never on the common path.
 */
export class ModuleIdentityFingerprints implements ModuleIdentityComparer {
  #references = new WeakMap<object, number>();
  #symbols = new Map<symbol, number>();
  #fingerprints = new WeakMap<object, string>();
  #nextReference = 0;

  /** True when the recorded inputs differ. */
  conflicts(first: ModuleIdentity, repeat: ModuleIdentity): boolean {
    if (first.inputs === repeat.inputs) return false;
    return this.fingerprint(first) !== this.fingerprint(repeat);
  }

  private fingerprint(identity: ModuleIdentity): string {
    let fingerprint = this.#fingerprints.get(identity);
    if (fingerprint === undefined) {
      fingerprint = this.value(identity.inputs, new Set());
      this.#fingerprints.set(identity, fingerprint);
    }
    return fingerprint;
  }

  private reference(value: object): string {
    let id = this.#references.get(value);
    if (id === undefined) {
      id = this.#nextReference++;
      this.#references.set(value, id);
    }
    return `ref#${id}`;
  }

  private symbol(value: symbol): string {
    let id = this.#symbols.get(value);
    if (id === undefined) {
      id = this.#nextReference++;
      this.#symbols.set(value, id);
    }
    return `sym#${id}`;
  }

  private value(value: unknown, path: Set<object>): string {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'symbol') return this.symbol(value);
    if (typeof value === 'function') return this.reference(value);
    if (typeof value !== 'object') return `${typeof value}:${String(value)}`;
    // A cycle is only reachable through a reference; compare it as one.
    if (path.has(value)) return this.reference(value);

    path.add(value);
    try {
      if (Array.isArray(value)) {
        return `[${value.map((item: unknown) => this.value(item, path)).join(',')}]`;
      }
      if (isDynamicModule(value)) {
        const nested = readModuleIdentity(value);
        if (nested) {
          const key = JSON.stringify(moduleKeyOf(value));
          return `module(${this.reference(value.module)},${key},${this.value(nested.inputs, path)})`;
        }
      }
      if (isProviderDefinition(value)) {
        return `provider${this.value(getProviderOptions(value), path)}`;
      }
      if (!isPlainObject(value)) return this.reference(value);
      // Enumerable own keys, symbols included (compared by reference like
      // symbol values); sorting the rendered entries makes key order irrelevant.
      // A key set to `undefined` is an option not given: `{ prefix: undefined }`
      // configures what `{}` does.
      const keys: Array<string | symbol> = [
        ...Object.keys(value),
        ...Object.getOwnPropertySymbols(value).filter((key) =>
          Object.prototype.propertyIsEnumerable.call(value, key),
        ),
      ];
      const entries = keys
        .flatMap((key) => {
          const entry: unknown = Reflect.get(value, key);
          if (entry === undefined) return [];
          const name = typeof key === 'symbol' ? this.symbol(key) : JSON.stringify(key);
          return [`${name}:${this.value(entry, path)}`];
        })
        .toSorted();
      return `{${entries.join(',')}}`;
    } finally {
      path.delete(value);
    }
  }
}
