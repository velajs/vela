import {
  Controller,
  Container,
  Inject,
  defineMetadata,
  defineModule,
  defineProvider,
  DiscoveryService,
  InjectionToken,
  Injectable,
  registerRouteContributor,
  type AsyncModuleOptions,
  type DynamicModule,
  type Entrypoint,
  type ModuleImport,
  type Provider,
  type Token,
} from '@velajs/vela';
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
  name: string;
  /** Declared Wrangler service binding. Transport is supplied through fetch. */
  binding?: string;
  imports?: ModuleImport[];
}
export type RpcClientAsyncOptions<Inject extends readonly Token[] = readonly Token[]> =
  AsyncModuleOptions<RpcClientOptions, Inject> & {
    name: string;
    binding?: string;
  };

function clientModule(
  name: string,
  binding: string | undefined,
  imports: ModuleImport[] | undefined,
  provider: Provider,
  options: InjectionToken<RpcClientOptions>,
): DynamicModule {
  const token = rpcClientToken(name);
  if (binding !== undefined && !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(binding)) {
    throw new TypeError('Invalid RPC service binding name');
  }
  @Injectable()
  class ClientDeclaration {
    constructor(@Inject(Container) private readonly container: Container) {}
    collectEntrypoints(): Entrypoint[] {
      if (this.container.getOwnerModuleIds(token).length !== 1)
        throw new Error(
          `Duplicate RPC client registration '${name}'. Reuse the same module import.`,
        );
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
  class RpcClientRegistration {}
  return {
    module: RpcClientRegistration,
    key: name,
    imports: imports ?? [],
    providers: [
      provider,
      ClientDeclaration,
      defineProvider(token, {
        inject: [options],
        useFactory: (config) => {
          if (binding !== undefined && !config.fetch)
            throw new TypeError('A declared RPC binding requires a fetch transport');
          return createRpcClient(config);
        },
      }),
    ],
    exports: [token],
  };
}

export class RpcClientModule {
  static register({ name, binding, imports, ...config }: RpcClientModuleOptions): DynamicModule {
    const options = new InjectionToken<RpcClientOptions>(`RPC client options: ${name}`);
    return clientModule(
      name,
      binding,
      imports,
      defineProvider(options, { useValue: config }),
      options,
    );
  }
  static registerAsync<const Inject extends readonly Token[]>(
    config: RpcClientAsyncOptions<Inject>,
  ): DynamicModule {
    const options = new InjectionToken<RpcClientOptions>(`RPC client options: ${config.name}`);
    return clientModule(
      config.name,
      config.binding,
      config.imports,
      {
        provide: options,
        useFactory: config.useFactory,
        ...(config.inject && { inject: config.inject }),
      },
      options,
    );
  }
}
