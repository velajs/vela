import {
  ForwardRef,
  getProviderOptions,
  isProviderDefinition,
  type Type,
} from '../container/types';
import type { DynamicModule, ModuleImport } from '../registry/types';

export const DEFAULT_MODULE_KEY = 'default';

export function isDynamicModule(value: unknown): value is DynamicModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'module' in value &&
    typeof value.module === 'function'
  );
}

/** Shared runtime and metadata identity: the constructor object plus its key. */
export function moduleKeyOf(entry: Type | DynamicModule): string {
  return isDynamicModule(entry) ? (entry.key ?? DEFAULT_MODULE_KEY) : DEFAULT_MODULE_KEY;
}

export function unwrapModuleImport(entry: ModuleImport): Type | DynamicModule {
  if (!(entry instanceof ForwardRef)) return entry;
  const result = entry.factory();
  if (typeof result === 'function' || isDynamicModule(result)) return result;
  throw new Error(
    'forwardRef in module imports must resolve to a module class or DynamicModule; ' +
      `got ${typeof result === 'object' ? 'a non-module object' : typeof result}.`,
  );
}

export type ModuleEntryList = 'imports' | 'providers' | 'controllers' | 'exports';

/**
 * A module lists `undefined` (or `null`) where a class, provider or token
 * belongs. A circular file import is the usual cause: the list is evaluated
 * while the other file has not initialized the binding yet.
 */
export class UndefinedModuleError extends Error {
  constructor(
    public readonly moduleName: string,
    public readonly property: ModuleEntryList,
    public readonly index: number,
    value: null | undefined,
  ) {
    super(
      `${moduleName}.${property}[${index}] is ${String(value)} — usually a circular file import; ` +
        (property === 'imports'
          ? 'use forwardRef(() => X)'
          : 'move the class into a file that does not import this module, or break the cycle'),
    );
    this.name = 'UndefinedModuleError';
  }
}

/** Reject nullish entries before any of them is unwrapped, registered or exported. */
export function assertDefinedEntries(
  moduleName: string,
  property: ModuleEntryList,
  entries: readonly unknown[],
): void {
  entries.forEach((entry, index) => {
    if (entry === undefined || entry === null) {
      throw new UndefinedModuleError(moduleName, property, index, entry);
    }
  });
}

// Call-time inputs that decide what a (class, key) module instance contributes.
// Non-enumerable, so spreading or comparing a DynamicModule never carries it.
const MODULE_IDENTITY = Symbol('vela:module-identity');

/**
 * @internal Record the inputs a generated DynamicModule was built from
 * (`defineModule`, `sideEffectModule`, `defineConfigurableModule`), so the
 * loader can tell a repeated identical import from a conflicting one.
 */
export function attachModuleIdentity<T extends DynamicModule>(definition: T, inputs: unknown): T {
  if (Object.isExtensible(definition)) {
    Object.defineProperty(definition, MODULE_IDENTITY, {
      value: Object.freeze({ inputs }),
      enumerable: false,
    });
  }
  return definition;
}

function readModuleIdentity(definition: object): { readonly inputs: unknown } | undefined {
  const identity: unknown = Reflect.get(definition, MODULE_IDENTITY);
  return typeof identity === 'object' && identity !== null && 'inputs' in identity
    ? identity
    : undefined;
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Compares module identity inputs for ONE module loader. Values compare
 * structurally and functions by source text, so a shared helper that rebuilds
 * the same `forRootAsync` config (a new closure each call) is one input.
 * Classes, native or bound functions, symbols and class instances compare by
 * reference, through ids this instance hands out: a class is a token, and a
 * bound function's source hides its target. The ids are owned by the loader
 * (never the process), so they are released with it and cannot leak across
 * applications. Fingerprints are only built for repeated imports, never on
 * the common path.
 */
export class ModuleIdentityFingerprints {
  #references = new WeakMap<object, number>();
  #symbols = new Map<symbol, number>();
  #fingerprints = new WeakMap<object, string>();
  #nextReference = 0;

  /**
   * True when both definitions record their inputs and those inputs differ.
   * Hand-written DynamicModules carry no inputs and are never reported.
   */
  conflicts(first: DynamicModule, repeat: DynamicModule): boolean {
    if (first === repeat) return false;
    const firstIdentity = readModuleIdentity(first);
    const repeatIdentity = readModuleIdentity(repeat);
    if (!firstIdentity || !repeatIdentity) return false;
    if (firstIdentity.inputs === repeatIdentity.inputs) return false;
    return this.fingerprint(firstIdentity) !== this.fingerprint(repeatIdentity);
  }

  private fingerprint(identity: { readonly inputs: unknown }): string {
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

  private function(value: Function): string {
    const source = Function.prototype.toString.call(value);
    if (/^class\b/.test(source) || source.includes('[native code]')) return this.reference(value);
    return `fn:${JSON.stringify(source)}`;
  }

  private value(value: unknown, path: Set<object>): string {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'symbol') return this.symbol(value);
    if (typeof value === 'function') return this.function(value);
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
      const entries = Object.keys(value)
        .toSorted()
        .map((key) => `${JSON.stringify(key)}:${this.value(Reflect.get(value, key), path)}`);
      return `{${entries.join(',')}}`;
    } finally {
      path.delete(value);
    }
  }
}
