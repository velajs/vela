/**
 * The one way a panel joins Studio: `StudioModule.forRoot({ plugins: [...] })`.
 * A plugin contributes providers (its `@AdminRpc` op classes and the ports
 * they serve) to StudioModule's own scope, so they inject Studio's signers,
 * buffers and resolved config without re-importing the configured module.
 */
import type { ModuleImport, ProviderDefinition, Type } from '@velajs/vela';

/** One Studio panel: providers registered inside the configured StudioModule. */
export interface StudioPlugin {
  /** The panel's name; each name appears once per StudioModule. */
  readonly name: string;
  /** Modules the panel's providers need. */
  readonly imports?: readonly ModuleImport[];
  /** Providers and `@AdminRpc` op classes the panel registers in Studio's scope. */
  readonly providers?: readonly (Type | ProviderDefinition)[];
}

const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/u;

/** Check a plugin's shape and freeze it; panel factories return one. */
export function defineStudioPlugin(plugin: StudioPlugin): StudioPlugin {
  if (typeof plugin?.name !== 'string' || plugin.name.length === 0) {
    throw new TypeError('A Studio plugin needs a non-empty name.');
  }
  if (!PLUGIN_NAME.test(plugin.name)) {
    throw new TypeError(
      `Studio plugin name '${plugin.name}' must be lower-case letters, digits and dashes.`,
    );
  }
  return Object.freeze({
    name: plugin.name,
    ...(plugin.imports === undefined ? {} : { imports: Object.freeze([...plugin.imports]) }),
    ...(plugin.providers === undefined ? {} : { providers: Object.freeze([...plugin.providers]) }),
  });
}

/** The plugins of one StudioModule, each name once. */
export function collectStudioPlugins(plugins: readonly StudioPlugin[] | undefined): StudioPlugin[] {
  const names = new Set<string>();
  return (plugins ?? []).map((plugin) => {
    const checked = defineStudioPlugin(plugin);
    if (names.has(checked.name)) {
      throw new TypeError(`Studio plugin '${checked.name}' is registered twice.`);
    }
    names.add(checked.name);
    return checked;
  });
}
