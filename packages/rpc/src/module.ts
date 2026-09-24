import {
  Controller,
  Inject,
  defineModule,
  defineProvider,
  InjectionToken,
  Injectable,
  type ConfigurableModuleAsyncOptions,
  type Token,
} from '@velajs/vela';
import {
  Container,
  defineMetadata,
  DiscoveryService,
  registerRouteContributor,
  type Entrypoint,
} from '@velajs/vela/module-kit';
import { createRpcClient, type RpcClient, type RpcClientOptions } from './client';
import { RpcRegistry, type RpcAdapterOptions } from './dispatcher';

const ENDPOINT = 'vela:rpc:endpoint';
export interface RpcModuleOptions extends RpcAdapterOptions {}

registerRouteContributor({
  id: 'vela:rpc',
  claimsMetaKey: ENDPOINT,
  async buildRoutes(app, context) {
    const token = context.meta;
    if (!(token instanceof InjectionToken)) throw new TypeError('Invalid RPC module metadata');
    const owners = context.container.getOwnerModuleIds(context.controller);
    if (owners.length !== 1) throw new Error('RPC endpoint must have exactly one module owner');
    const options: unknown = await context.container.resolveAsync(token, owners[0]);
    if (typeof options !== 'object' || options === null || !('authorize' in options)) {
      throw new TypeError('RPC requires an explicit authorize policy');
    }
    const authorize = options.authorize;
    if (authorize !== 'public' && typeof authorize !== 'function') {
      throw new TypeError('RPC requires an explicit authorize policy');
    }
    const path = 'path' in options ? options.path : '/rpc';
    if (
      typeof path !== 'string' ||
      !path.startsWith('/') ||
      path.endsWith('/') ||
      path.includes('//') ||
      /[^A-Za-z0-9_/-]/.test(path)
    ) {
      throw new TypeError('RPC path must be a concrete absolute path without a trailing slash');
    }
    if (
      app.routes.some(
        (route) => route.path === path && (route.method === 'POST' || route.method === 'ALL'),
      )
    ) {
      throw new Error(`RPC route conflicts with existing route '${path}'`);
    }
    const registry = new RpcRegistry(
      {
        discovery: context.container.resolve(DiscoveryService),
        getGlobalComponents: context.getGlobalComponents,
      },
      authorize as RpcAdapterOptions['authorize'],
    );
    app.post(path, (c) => registry.handle(c));
  },
});

const { ConfigurableModuleClass } = defineModule<RpcModuleOptions>({
  name: 'Rpc',
  setup: ({ OPTIONS }) => {
    class RpcEndpoint {}
    Controller('')(RpcEndpoint);
    defineMetadata(ENDPOINT, OPTIONS, RpcEndpoint);
    return { controllers: [RpcEndpoint] };
  },
});

/** Import once in an application to expose its registered @Rpc procedures. */
export class RpcModule extends ConfigurableModuleClass {}

const CLIENT_TOKENS = Symbol.for('vela:rpc:client-tokens:v1');
function clientTokens(): Map<string, InjectionToken<RpcClient>> {
  const state = globalThis as unknown as Record<
    symbol,
    Map<string, InjectionToken<RpcClient>> | undefined
  >;
  return (state[CLIENT_TOKENS] ??= new Map());
}
export function rpcClientToken(name: string): InjectionToken<RpcClient> {
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name)) throw new TypeError('Invalid RPC client name');
  const clients = clientTokens();
  let token = clients.get(name);
  if (!token) {
    token = new InjectionToken<RpcClient>(`vela:rpc:client:${name}`);
    clients.set(name, token);
  }
  return token;
}

export interface RpcClientModuleOptions extends RpcClientOptions {
  /** Client name: inject the client with `rpcClientToken(name)`. Structural. */
  name: string;
  /** Declared Wrangler service binding. Transport is supplied through fetch. Structural. */
  binding?: string;
}

/** The options `forRootAsync` takes alongside its factory: they declare the client. */
export type RpcClientStructuralOption = 'name' | 'binding';

/** Deferred client registration; a factory without parameters may omit `inject`. */
export type RpcClientAsyncOptions<Inject extends readonly Token[] = readonly Token[]> =
  ConfigurableModuleAsyncOptions<
    RpcClientModuleOptions,
    RpcClientStructuralOption,
    'create',
    Inject
  >;

const RPC_CLIENT_OPTIONS = new InjectionToken<RpcClientModuleOptions>('vela:rpc:client-options');

/** Declares one registration's client to the application's entrypoints. */
@Injectable()
class RpcClientDeclaration {
  constructor(
    @Inject(Container) private readonly container: Container,
    @Inject(RPC_CLIENT_OPTIONS) private readonly options: RpcClientModuleOptions,
  ) {}
  collectEntrypoints(): Entrypoint[] {
    const { name, binding } = this.options;
    const token = rpcClientToken(name);
    if (this.container.getOwnerModuleIds(token).length !== 1)
      throw new Error(`Duplicate RPC client registration '${name}'. Reuse the same module import.`);
    return [
      {
        kind: 'rpc:client',
        token,
        instance: undefined,
        meta: { name, ...(binding ? { binding } : {}) },
      },
    ];
  }
}

const { ConfigurableModuleClass: RpcClientModuleHost } = defineModule<
  RpcClientModuleOptions,
  RpcClientStructuralOption
>({
  name: 'RpcClient',
  optionsToken: RPC_CLIENT_OPTIONS,
  structural: ['name', 'binding'],
  setup: ({ OPTIONS, options: { name, binding } }) => {
    const token = rpcClientToken(name);
    if (binding !== undefined && !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(binding)) {
      throw new TypeError('Invalid RPC service binding name');
    }
    return {
      providers: [
        RpcClientDeclaration,
        defineProvider(token, {
          inject: [OPTIONS],
          useFactory: ({ name: _name, binding: _binding, ...config }) => {
            if (binding !== undefined && !config.fetch)
              throw new TypeError('A declared RPC binding requires a fetch transport');
            return createRpcClient(config);
          },
        }),
      ],
      exports: [token],
    };
  },
});

/**
 * Registers a named RPC client, injected with `rpcClientToken(name)`.
 * `name` and `binding` are structural: `forRootAsync` takes them alongside its
 * factory, which returns the transport settings (`url`, `fetch`, ...).
 */
export class RpcClientModule extends RpcClientModuleHost {}
