import {
  All,
  Controller,
  defineProvider,
  DiscoveryService,
  Inject,
  Injectable,
  InjectionToken,
  Req,
  type DynamicModule,
  type ModuleImport,
  type VelaContext,
} from '@velajs/vela';
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
  readonly imports?: ModuleImport[];
}

export class GraphqlModule {
  static forRoot(options: GraphqlModuleOptions): DynamicModule {
    const path = options.path ?? '/graphql';
    if (!/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(path) || (path.endsWith('/') && path !== '/')) {
      throw new TypeError(
        'GraphQL path must be an absolute literal route without a trailing slash',
      );
    }
    const service = new InjectionToken<GraphqlService>('GraphqlService');
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
    Injectable()(GraphqlController);
    Controller(path)(GraphqlController);
    Inject(service)(GraphqlController, undefined, 0);
    All()(
      GraphqlController.prototype,
      'handle',
      Object.getOwnPropertyDescriptor(GraphqlController.prototype, 'handle')!,
    );
    Req()(GraphqlController.prototype, 'handle', 0);
    class Registration {}
    return {
      module: Registration,
      imports: options.imports ?? [],
      controllers: [GraphqlController],
      providers: [
        defineProvider(service, {
          inject: [DiscoveryService],
          useFactory: (discovery) => new GraphqlService(options, discovery),
        }),
      ],
    };
  }
}
