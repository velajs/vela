/**
 * The one way a panel joins Studio: `StudioModule.forRoot({ plugins: [...] })`.
 * A plugin contributes providers (its `@AdminRpc` op classes and the ports
 * they serve) to StudioModule's own scope, so they inject Studio's signers,
 * buffers and resolved config without re-importing the configured module.
 */
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_MIDDLEWARE,
  APP_PIPE,
  type ModuleImport,
  type ProviderDefinition,
  type Token,
  type Type,
} from '@velajs/vela';
import { describeToken } from '@velajs/vela/module-kit';

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

// Application-wide enhancers collect every registration, so panels may share them.
const COLLECTED = new Set<Token>([
  APP_GUARD,
  APP_PIPE,
  APP_INTERCEPTOR,
  APP_FILTER,
  APP_MIDDLEWARE,
]);

/** The token a provider registers under. */
export function providerToken(provider: Type | ProviderDefinition): Token {
  return typeof provider === 'function' ? provider : provider.provide;
}

/**
 * The plugins of one StudioModule, each name once. A plugin providing one of
 * StudioModule's own tokens (`reserved`), or a token another plugin provides
 * (two time-travel tiers binding `TIME_TRAVEL_PORT`), fails, since the later
 * registration would silently replace the earlier.
 */
export function collectStudioPlugins(
  plugins: readonly StudioPlugin[] | undefined,
  reserved: readonly Token[] = [],
): StudioPlugin[] {
  const core = new Set(reserved);
  const names = new Set<string>();
  const owners = new Map<Token, string>();
  return (plugins ?? []).map((plugin) => {
    const checked = defineStudioPlugin(plugin);
    if (names.has(checked.name)) {
      throw new TypeError(`Studio plugin '${checked.name}' is registered twice.`);
    }
    names.add(checked.name);
    for (const provider of checked.providers ?? []) {
      const token = providerToken(provider);
      if (COLLECTED.has(token)) continue;
      if (core.has(token)) {
        throw new TypeError(
          `Studio plugin '${checked.name}' provides ${describeToken(token)}, which StudioModule ` +
            'provides itself; a panel cannot replace it.',
        );
      }
      const owner = owners.get(token);
      if (owner !== undefined && owner !== checked.name) {
        throw new TypeError(
          `Studio plugins '${owner}' and '${checked.name}' both provide ${describeToken(token)}; ` +
            'register only one of them.',
        );
      }
      owners.set(token, checked.name);
    }
    return checked;
  });
}
