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
