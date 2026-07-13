import { InjectionToken } from '../container/types';
import type { Type } from '../container/types';
import { Module } from '../module/decorators';
import type { DynamicModule } from '../registry/types';

export interface Plugin {
  id: string;
  version: string;
  module: Type | DynamicModule;
  dependsOn?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Freeze and validate a plugin manifest. Returns the same object so it can
 * be used in `composePlugins([definePlugin(...), ...])`.
 */
export function definePlugin(plugin: Plugin): Plugin {
  if (!plugin.id) throw new Error('Plugin requires an id');
  if (!plugin.version) throw new Error('Plugin requires a version');
  if (!plugin.module) throw new Error('Plugin requires a module');
  return Object.freeze({ ...plugin });
}

export class PluginRegistry {
  private byId: Map<string, Plugin>;

  constructor(plugins: readonly Plugin[]) {
    this.byId = new Map();
    for (const p of plugins) {
      if (this.byId.has(p.id)) {
        throw new Error(`Duplicate plugin id: '${p.id}'`);
      }
      this.byId.set(p.id, p);
    }
  }

  list(): Plugin[] {
    return [...this.byId.values()];
  }

  get(id: string): Plugin | undefined {
    return this.byId.get(id);
  }

  dependents(id: string): Plugin[] {
    return this.list().filter((p) => p.dependsOn?.includes(id) ?? false);
  }
}

export const PLUGIN_REGISTRY_TOKEN = new InjectionToken<PluginRegistry>('PLUGIN_REGISTRY');

@Module({})
export class PluginRootModule {}

/**
 * Topologically sort plugins so each plugin's dependencies appear first.
 * Throws on missing dependencies and cycles.
 */
function topologicalSort(plugins: readonly Plugin[]): Plugin[] {
  const byId = new Map<string, Plugin>();
  for (const p of plugins) {
    if (byId.has(p.id)) {
      throw new Error(`Duplicate plugin id: '${p.id}'`);
    }
    byId.set(p.id, p);
  }

  const result: Plugin[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (p: Plugin, path: string[]): void => {
    if (visited.has(p.id)) return;
    if (visiting.has(p.id)) {
      const cycle = [...path, p.id].join(' -> ');
      throw new Error(`Plugin cycle detected: ${cycle}`);
    }
    visiting.add(p.id);
    for (const depId of p.dependsOn ?? []) {
      const dep = byId.get(depId);
      if (!dep) {
        throw new Error(`Plugin '${p.id}' depends on missing plugin '${depId}'`);
      }
      visit(dep, [...path, p.id]);
    }
    visiting.delete(p.id);
    visited.add(p.id);
    result.push(p);
  };

  for (const p of plugins) visit(p, []);
  return result;
}

/**
 * Compose a list of plugins into a single dynamic module that imports each
 * plugin's module in dependency order, registers a `PluginRegistry`, and
 * exposes it globally so any plugin can introspect peers.
 */
export function composePlugins(plugins: readonly Plugin[]): DynamicModule {
  const sorted = topologicalSort(plugins);
  const registry = new PluginRegistry(sorted);

  return {
    module: PluginRootModule,
    imports: sorted.map((p) => p.module),
    providers: [{ provide: PLUGIN_REGISTRY_TOKEN, useValue: registry }],
    exports: [PLUGIN_REGISTRY_TOKEN],
    global: true,
  };
}
