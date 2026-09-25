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
  ENV,
  type ModuleImport,
  type ProviderDefinition,
  type Token,
  type Type,
} from '@velajs/vela';
import { APP_LOGGER } from '@velajs/vela/logging';
import {
  Container,
  DiscoveryService,
  EntrypointRegistry,
  ROOT_MODULE,
  describeToken,
} from '@velajs/vela/module-kit';

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

// Framework tokens Studio and its panels read from the application. They
// resolve them application-wide, as app.get() does (STUDIO_APPLICATION_CONTAINER),
// so a module a plugin imports never answers for them. A plugin's provider of
// one would register it in Studio's own scope: it would answer first for the
// panels' providers there, and where the application registers none (ENV
// without a seeded environment, APP_LOGGER without LoggingModule) it would be
// what application-wide lookups, Studio's among them, return. (`ModuleRef`
// needs no entry: the container answers it itself.)
const INJECTED = new Set<Token>([
  ENV,
  APP_LOGGER,
  ROOT_MODULE,
  Container,
  DiscoveryService,
  EntrypointRegistry,
]);

/** The token a provider registers under. */
export function providerToken(provider: Type | ProviderDefinition): Token {
  return typeof provider === 'function' ? provider : provider.provide;
}

/**
 * The plugins of one StudioModule, each name once. A plugin providing one of
 * StudioModule's own tokens (`reserved`), a framework token Studio reads from
 * the application (`ENV`, `APP_LOGGER`, `ROOT_MODULE`, `Container`,
 * `DiscoveryService`, `EntrypointRegistry`), or a token another plugin
 * provides (two time-travel tiers binding `TIME_TRAVEL_PORT`) fails, since
 * the later registration would silently replace the earlier inside Studio's
 * scope. A plugin's imports are not checked: Studio never resolves those
 * framework tokens in its own scope, so what an import exports cannot replace
 * the application's.
 */
export function collectStudioPlugins(
  plugins: readonly StudioPlugin[] | undefined,
  reserved: readonly Token[] = [],
): StudioPlugin[] {
  const core = new Set(reserved);
  const names = new Set<string>();
  const owners = new Map<Token, string>();
  return (plugins ?? []).map((plugin) => {
    const defined = defineStudioPlugin(plugin);
    if (names.has(defined.name)) {
      throw new TypeError(`Studio plugin '${defined.name}' is registered twice.`);
    }
    names.add(defined.name);
    for (const provider of defined.providers ?? []) {
      const token = providerToken(provider);
      if (COLLECTED.has(token)) continue;
      if (core.has(token)) {
        throw new TypeError(
          `Studio plugin '${defined.name}' provides ${describeToken(token)}, which StudioModule ` +
            'provides itself; a panel cannot replace it.',
        );
      }
      if (INJECTED.has(token)) {
        throw new TypeError(
          `Studio plugin '${defined.name}' provides ${describeToken(token)}, which StudioModule ` +
            'injects from the application; a panel cannot replace it.',
        );
      }
      const owner = owners.get(token);
      if (owner !== undefined && owner !== defined.name) {
        throw new TypeError(
          `Studio plugins '${owner}' and '${defined.name}' both provide ${describeToken(token)}; ` +
            'register only one of them.',
        );
      }
      owners.set(token, defined.name);
    }
    return defined;
  });
}
