import type { Type } from '../container/types';
import { getModuleMetadata } from './decorators';
import type { DynamicModule, ModuleImport } from '../registry/types';
import {
  assertDefinedEntries,
  isDynamicModule,
  moduleKeyOf,
  unwrapModuleImport,
} from './module-identity';

/**
 * Walks the module dependency graph from a root, unwrapping ForwardRef and
 * dynamic-module imports along the way, and returns every controller
 * reachable from it. Pure metadata read — no Container, no side effects.
 *
 * Used by createOpenApiDocument and any other consumer that needs a
 * controller list without bootstrapping the application.
 */
export function collectControllers(rootModule: Type | DynamicModule): Type[] {
  const visited = new Map<Type, Set<string>>();
  const controllers = new Set<Type>();

  const visit = (entry: ModuleImport | Type | DynamicModule): void => {
    const unwrapped = unwrapModuleImport(entry);
    const moduleClass = isDynamicModule(unwrapped) ? unwrapped.module : (unwrapped as Type);
    const extraControllers = isDynamicModule(unwrapped) ? (unwrapped.controllers ?? []) : [];
    const extraImports = isDynamicModule(unwrapped) ? (unwrapped.imports ?? []) : [];

    if (typeof moduleClass !== 'function') return;
    const key = moduleKeyOf(unwrapped);
    if (visited.get(moduleClass)?.has(key)) {
      // Match the loader: repeated definitions still contribute controllers.
      for (const controller of extraControllers) controllers.add(controller);
      return;
    }
    const keys = visited.get(moduleClass) ?? new Set<string>();
    keys.add(key);
    visited.set(moduleClass, keys);

    const metadata = getModuleMetadata(moduleClass);
    // Same guard as the loader: a nullish entry is a wiring error, not an absence.
    const name = moduleClass.name || 'AnonModule';
    assertDefinedEntries(name, 'imports', [...(metadata?.imports ?? []), ...extraImports]);
    assertDefinedEntries(name, 'controllers', [
      ...(metadata?.controllers ?? []),
      ...extraControllers,
    ]);
    if (metadata) {
      for (const controller of metadata.controllers) controllers.add(controller);
      for (const imp of metadata.imports) visit(imp);
    }
    for (const controller of extraControllers) controllers.add(controller);
    for (const imp of extraImports) visit(imp);
  };

  visit(rootModule);
  return [...controllers];
}
