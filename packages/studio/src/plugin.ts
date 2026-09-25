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
  ForwardRef,
  forwardRef,
  type DynamicModule,
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
  MetadataRegistry,
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

// Framework tokens StudioModule and its panels inject from the application:
// provided in its scope, or exported by a module a panel imports, a panel's
// registration would answer first, so Studio would read the panel's ENV (the
// admin token among it), log through its logger, or describe another
// application. (`ModuleRef` needs no entry: the container answers it itself.)
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

function isDynamicModule(value: unknown): value is DynamicModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'module') === 'function'
  );
}

/** The module a forwardRef names, or undefined while its file has not loaded it yet. */
function forwarded(entry: ForwardRef): Type | DynamicModule | undefined {
  let target: Token;
  try {
    target = entry.factory();
  } catch {
    return undefined;
  }
  return typeof target === 'function' || isDynamicModule(target) ? target : undefined;
}

/**
 * The tokens a module import makes visible to the module importing it, as the
 * module loader reads them: the class's `@Module()` exports and a
 * DynamicModule's own, where an exported module class it imports
 * (`exports: [SourceModule]`) stands for that module's exports in turn. A
 * forwardRef whose module has not loaded yet contributes nothing here.
 */
function importedTokens(entry: ModuleImport, seen: Set<object> = new Set()): Token[] {
  const imported = entry instanceof ForwardRef ? forwarded(entry) : entry;
  if (imported === undefined || seen.has(imported)) return [];
  seen.add(imported);
  const moduleClass = typeof imported === 'function' ? imported : imported.module;
  const record = MetadataRegistry.getModuleOptions(moduleClass);
  const dynamic = typeof imported === 'function' ? undefined : imported;
  const imports = [...(record?.imports ?? []), ...(dynamic?.imports ?? [])];
  return [...(record?.exports ?? []), ...(dynamic?.exports ?? [])].flatMap((token) => {
    const reexported = imports.filter((candidate) => {
      const resolved = candidate instanceof ForwardRef ? forwarded(candidate) : candidate;
      return (typeof resolved === 'function' ? resolved : resolved?.module) === token;
    });
    return reexported.length === 0
      ? [token]
      : reexported.flatMap((candidate) => importedTokens(candidate, seen));
  });
}

/** The name a module import shows in messages. */
function importName(imported: Type | DynamicModule): string {
  return (
    (typeof imported === 'function' ? imported : imported.module).name || 'an anonymous module'
  );
}

/** Throw when `imported` exports a framework token StudioModule injects. */
function assertImportKeepsInjected(plugin: string, imported: Type | DynamicModule): void {
  const token = importedTokens(imported).find((candidate) => INJECTED.has(candidate));
  if (token === undefined) return;
  throw new TypeError(
    `Studio plugin '${plugin}' imports ${importName(imported)}, which exports ` +
      `${describeToken(token)}; StudioModule injects it from the application, so a panel ` +
      'cannot replace it.',
  );
}

/**
 * A plugin import, checked: a module exporting a framework token StudioModule
 * injects fails now, and a forwardRef, whose module may not have loaded yet,
 * fails when the module loader resolves it.
 */
function checkedImport(plugin: string, entry: ModuleImport): ModuleImport {
  if (!(entry instanceof ForwardRef)) {
    assertImportKeepsInjected(plugin, entry);
    return entry;
  }
  return forwardRef(() => {
    const target = entry.factory();
    if (typeof target === 'function' || isDynamicModule(target)) {
      assertImportKeepsInjected(plugin, target);
    }
    return target;
  });
}

/**
 * The plugins of one StudioModule, each name once. A plugin providing one of
 * StudioModule's own tokens (`reserved`), a framework token StudioModule
 * injects from the application (`ENV`, `APP_LOGGER`, `ROOT_MODULE`,
 * `Container`, `DiscoveryService`, `EntrypointRegistry`) or importing a module
 * that exports one, or a token another plugin provides (two time-travel tiers
 * binding `TIME_TRAVEL_PORT`), fails, since the later registration would
 * silently replace the earlier inside Studio's scope.
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
    const checked =
      defined.imports === undefined
        ? defined
        : Object.freeze({
            ...defined,
            imports: Object.freeze(
              defined.imports.map((entry) => checkedImport(defined.name, entry)),
            ),
          });
    for (const provider of checked.providers ?? []) {
      const token = providerToken(provider);
      if (COLLECTED.has(token)) continue;
      if (core.has(token)) {
        throw new TypeError(
          `Studio plugin '${checked.name}' provides ${describeToken(token)}, which StudioModule ` +
            'provides itself; a panel cannot replace it.',
        );
      }
      if (INJECTED.has(token)) {
        throw new TypeError(
          `Studio plugin '${checked.name}' provides ${describeToken(token)}, which StudioModule ` +
            'injects from the application; a panel cannot replace it.',
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
