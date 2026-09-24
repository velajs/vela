import { ForwardRef, type Type } from '../container/types';
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

// The methods a generated module class configures itself with, as
// [sync, async]: a static, non-enumerable property its subclasses inherit.
const GENERATED_MODULE_METHODS = Symbol('vela:generated-module-methods');

/** @internal Records the methods `defineModule` generated on its host class. */
export function recordGeneratedModuleMethods(host: object, methods: readonly [string, string]): void {
  Object.defineProperty(host, GENERATED_MODULE_METHODS, { value: Object.freeze([...methods]) });
}

/** @internal The methods a generated module class (or its subclass) configures itself with. */
export function generatedModuleMethods(moduleClass: object): readonly string[] | undefined {
  const methods: unknown = Reflect.get(moduleClass, GENERATED_MODULE_METHODS);
  return Array.isArray(methods) ? methods : undefined;
}

// Call-time inputs that decide what a (class, key) module instance contributes.
// Non-enumerable, so spreading or comparing a DynamicModule never carries it.
export const MODULE_IDENTITY = Symbol('vela:module-identity');

/**
 * @internal The inputs of an import that configures nothing: a bare class
 * import, or a generated definition that adds nothing to its class (no
 * options, extras, contributions or laziness the class does not declare).
 * Two of them agree; one never agrees with a configured import.
 */
export const UNCONFIGURED_MODULE: unique symbol = Symbol('vela:unconfigured-module');

/**
 * @internal What a generated DynamicModule records about the inputs it was
 * built from (see `attachModuleIdentity`). The record also creates the
 * comparer the module loader uses for repeated imports, so only applications
 * that build modules this way ship the comparison code.
 */
export interface ModuleIdentity {
  readonly inputs: unknown;
  readonly createComparer: () => ModuleIdentityComparer;
}

/** @internal Compares the recorded inputs of two definitions for ONE module loader. */
export interface ModuleIdentityComparer {
  /** True when the two recorded inputs differ. */
  conflicts(first: ModuleIdentity, repeat: ModuleIdentity): boolean;
}

/** @internal The identity a generated DynamicModule recorded, if any. */
export function readModuleIdentity(definition: object): ModuleIdentity | undefined {
  const identity: unknown = Reflect.get(definition, MODULE_IDENTITY);
  return typeof identity === 'object' &&
    identity !== null &&
    'inputs' in identity &&
    'createComparer' in identity &&
    typeof identity.createComparer === 'function'
    ? (identity as ModuleIdentity)
    : undefined;
}
