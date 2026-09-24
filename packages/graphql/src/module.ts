import {
  All,
  defineModule,
  Controller,
  defineProvider,
  Inject,
  InjectionToken,
  Req,
  type Type,
  type ModuleImport,
  type VelaContext,
} from '@velajs/vela';
import { DiscoveryService } from '@velajs/vela/module-kit';
import { assertValidSchema } from 'graphql';
import { GraphqlOperation } from './operation';
import type { GraphqlOptions, GraphqlServer } from './types';

class GraphqlService {
  readonly #options: GraphqlOptions;
  readonly #discovery: DiscoveryService;
  #server: Promise<GraphqlServer> | undefined;
  #closed = false;

  constructor(options: GraphqlOptions, discovery: DiscoveryService) {
    this.#options = options;
    this.#discovery = discovery;
  }

  #getServer(path: string): Promise<GraphqlServer> {
    if (this.#server) return this.#server;
    const pending = Promise.resolve().then(async () => {
      const schema =
        typeof this.#options.schema === 'function'
          ? await this.#options.schema({ discovery: this.#discovery })
          : this.#options.schema;
      assertValidSchema(schema);
      return this.#options.driver.create(schema, path);
    });
    this.#server = pending;
    void pending.catch(() => {
      if (this.#server === pending) this.#server = undefined;
    });
    return pending;
  }

  async handle(context: VelaContext): Promise<Response> {
    if (this.#closed) throw new Error('GraphQL application has closed');
    const operation = new GraphqlOperation(context, this.#options);
    try {
      const server = await this.#getServer(context.req.path);
      operation.assertActive();
      return await server.handle(operation.request, { operation });
    } finally {
      await operation.finish();
    }
  }

  async dispose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#server) {
      // Construction failures were already surfaced on the request path.
      const server = await this.#server.catch(() => undefined);
      await server?.dispose?.();
    }
  }
}

export interface GraphqlModuleOptions extends GraphqlOptions {
  /** Modules the endpoint's field guards, pipes and interceptors resolve from. Structural. */
  readonly imports?: ModuleImport[];
}

/** The options `forRootAsync` takes alongside its factory: they shape the module graph. */
export type GraphqlStructuralOption = 'path' | 'imports';

function graphqlPath(path: string | undefined): string {
  const resolved = path ?? '/graphql';
  // Independent linear scans avoid backtracking between segments and optional separators.
  if (
    !resolved.startsWith('/') ||
    (resolved.length > 1 && resolved.endsWith('/')) ||
    resolved.includes('//') ||
    /[^A-Za-z0-9_/-]/.test(resolved)
  ) {
    throw new TypeError('GraphQL path must be an absolute literal route without a trailing slash');
  }
  return resolved;
}

interface Endpoint {
  readonly service: InjectionToken<GraphqlService>;
  readonly controller: Type;
}

// One service token and controller class per mounted path, so a repeated
// registration of a path shares them rather than declaring new classes.
const endpoints = new Map<string, Endpoint>();

function endpointFor(path: string): Endpoint {
  const existing = endpoints.get(path);
  if (existing) return existing;
  const service = new InjectionToken<GraphqlService>(`GraphqlService:${path}`);
  class GraphqlController {
    readonly #service: GraphqlService;
    constructor(value: GraphqlService) {
      this.#service = value;
    }
    handle(context: VelaContext): Promise<Response> {
      return this.#service.handle(context);
    }
  }
  // Explicit tokens keep the package independent of decorator compiler metadata.
  Controller(path)(GraphqlController);
  Inject(service)(GraphqlController, undefined, 0);
  All()(
    GraphqlController.prototype,
    'handle',
    Object.getOwnPropertyDescriptor(GraphqlController.prototype, 'handle')!,
  );
  Req()(GraphqlController.prototype, 'handle', 0);
  const endpoint = { service, controller: GraphqlController };
  endpoints.set(path, endpoint);
  return endpoint;
}

const { ConfigurableModuleClass } = defineModule<GraphqlModuleOptions, GraphqlStructuralOption>({
  name: 'Graphql',
  structural: ['path', 'imports'],
  // One endpoint per path: another configuration of a path fails bootstrap.
  key: (options) => graphqlPath(options.path),
  setup: ({ OPTIONS, options }) => {
    const { service, controller } = endpointFor(graphqlPath(options.path));
    return {
      imports: options.imports ?? [],
      controllers: [controller],
      providers: [
        defineProvider(service, {
          inject: [DiscoveryService, OPTIONS],
          useFactory: (discovery, resolved) => new GraphqlService(resolved, discovery),
        }),
      ],
    };
  },
});

/**
 * Mounts a GraphQL endpoint (default `/graphql`) served by the configured
 * driver. `path` and `imports` are structural: `forRootAsync` takes them
 * alongside its factory, which returns the schema, driver and field pipeline.
 */
export class GraphqlModule extends ConfigurableModuleClass {}
