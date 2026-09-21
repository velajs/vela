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
