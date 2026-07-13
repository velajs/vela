import { ForwardRef } from '../container/types';
import type { Type } from '../container/types';
import { getModuleMetadata } from './decorators';
import type { DynamicModule, ModuleImport } from '../registry/types';

function isDynamicModuleLike(value: unknown): value is DynamicModule {
  return (
    !!value &&
    typeof value === 'object' &&
    'module' in value &&
    typeof (value as DynamicModule).module === 'function'
  );
}

/**
 * Walks the module dependency graph from a root, unwrapping ForwardRef and
 * dynamic-module imports along the way, and returns every controller
 * reachable from it. Pure metadata read — no Container, no side effects.
 *
 * Used by createOpenApiDocument and any other consumer that needs a
 * controller list without bootstrapping the application.
 */
export function collectControllers(rootModule: Type): Type[] {
  const visited = new Set<Type>();
  const controllers = new Set<Type>();

  const visit = (entry: ModuleImport | Type | DynamicModule): void => {
    const unwrapped =
      entry instanceof ForwardRef ? (entry.factory() as Type | DynamicModule) : entry;
    const moduleClass = isDynamicModuleLike(unwrapped) ? unwrapped.module : (unwrapped as Type);
    const extraControllers = isDynamicModuleLike(unwrapped) ? (unwrapped.controllers ?? []) : [];
    const extraImports = isDynamicModuleLike(unwrapped) ? (unwrapped.imports ?? []) : [];

    if (typeof moduleClass !== 'function' || visited.has(moduleClass)) return;
    visited.add(moduleClass);

    const metadata = getModuleMetadata(moduleClass);
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
