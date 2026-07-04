import type { Hono } from 'hono';
import type { Container } from './container/container';
import type { Token } from './container/types';
import { DiscoveryService } from './discovery/discovery.service';
import { EntrypointRegistry } from './entrypoint/entrypoint.registry';
import type { RouteManager } from './http/route.manager';
import {
  hasBeforeApplicationShutdown,
  hasOnApplicationBootstrap,
  hasOnApplicationShutdown,
  hasOnModuleDestroy,
  hasOnModuleInit,
} from './lifecycle/index';
import type { MountOpenApiOptions, OpenApiUi } from './openapi/types';
import { renderScalarUi } from './openapi/scalar-ui';
import { renderSwaggerUi } from './openapi/swagger-ui';
import { renderRedocUi } from './openapi/redoc-ui';
import type { FilterType, GuardType, InterceptorType, PipeType } from './registry/types';

export class VelaApplication {
  private instances: unknown[] = [];
  private honoApp: Hono | null = null;
  private entrypointRegistry: EntrypointRegistry | null = null;
  private disposed = false;

  constructor(
    private readonly container: Container,
    private readonly routeManager: RouteManager,
  ) {}

  /** Pre-build routes (handles async CRUD imports). Called by VelaFactory. */
  async initRoutes(): Promise<void> {
    this.honoApp = await this.routeManager.build();
  }

  private getApp(): Hono {
    if (!this.honoApp) {
      throw new Error(
        'Routes not built. This should not happen — VelaFactory.create() builds routes automatically.',
      );
    }
    return this.honoApp;
  }

  get fetch(): Hono['fetch'] {
    return this.getApp().fetch;
  }

  getInstances(): unknown[] {
    return this.instances;
  }

  getContainer(): Container {
    return this.container;
  }

  setInstances(instances: unknown[]): void {
    this.instances = instances;
  }

  get<T>(token: Token<T>): T {
    return this.container.resolve(token);
  }

  getHonoApp(): Hono {
    return this.getApp();
  }

  // Pipeline components — applied at request time, no rebuild needed

  useGlobalPipes(...pipes: PipeType[]): this {
    this.routeManager.useGlobalPipes(...pipes);
    return this;
  }

  useGlobalGuards(...guards: GuardType[]): this {
    this.routeManager.useGlobalGuards(...guards);
    return this;
  }

  useGlobalInterceptors(...interceptors: InterceptorType[]): this {
    this.routeManager.useGlobalInterceptors(...interceptors);
    return this;
  }

  useGlobalFilters(...filters: FilterType[]): this {
    this.routeManager.useGlobalFilters(...filters);
    return this;
  }

  /**
   * Serve a pre-built OpenAPI document and one or more interactive doc UIs
   * (Swagger UI, Scalar, ReDoc) on the underlying Hono app, mirroring the
   * hono-crud docs convention. Edge-safe: each UI is a tiny self-contained
   * HTML shell that loads its renderer from a CDN at runtime so nothing is
   * bundled server-side and no extra dependency is required.
   *
   * Defaults: spec at `/openapi.json`, Scalar at `/scalar`, Swagger UI at
   * `/docs`, ReDoc at `/redoc`. The deprecated `path` / `uiPath` aliases are
   * retained for migration from the previous single-UI shape.
   *
   * ```ts
   * const doc = createOpenApiDocument(AppModule);
   * app.mountOpenApi({ document: doc });            // Scalar @ /scalar
   * app.mountOpenApi({ document: doc, ui: 'all' }); // swagger + scalar + redoc
   * ```
   */
  mountOpenApi(options: MountOpenApiOptions): this {
    const app = this.getApp();
    const doc = options.document;
    const title = options.title;

    // Spec JSON: new default `/openapi.json`. The deprecated `path` alias is
    // honored as an override only (does not change the default).
    const specPath = options.specPath ?? options.path ?? '/openapi.json';
    app.get(specPath, (c) => c.json(doc));

    // Normalize the requested UI set. Default is Scalar only.
    const uiOption = options.ui;
    let uis: OpenApiUi[];
    let singleStringUi = false;
    if (uiOption === undefined) {
      uis = ['scalar'];
    } else if (uiOption === 'all') {
      uis = ['swagger', 'scalar', 'redoc'];
    } else if (Array.isArray(uiOption)) {
      uis = uiOption;
    } else {
      uis = [uiOption];
      singleStringUi = true;
    }

    for (const ui of uis) {
      // Back-compat: the old `{ ui: 'scalar', uiPath }` form mapped a single
      // string UI to `uiPath`. Honor that only when exactly one UI was
      // requested as a string.
      const legacyPath =
        singleStringUi && uis.length === 1 ? options.uiPath : undefined;

      if (ui === 'swagger') {
        const path = legacyPath ?? options.swaggerPath ?? '/docs';
        const html = renderSwaggerUi(specPath, title);
        app.get(path, (c) => c.html(html));
      } else if (ui === 'redoc') {
        const path = legacyPath ?? options.redocPath ?? '/redoc';
        const html = renderRedocUi(specPath, title);
        app.get(path, (c) => c.html(html));
      } else {
        const path = legacyPath ?? options.scalarPath ?? '/scalar';
        const html = renderScalarUi(specPath, title);
        app.get(path, (c) => c.html(html));
      }
    }

    return this;
  }

  // Lifecycle hooks

  async callOnModuleInit(): Promise<void> {
    for (const instance of this.instances) {
      if (hasOnModuleInit(instance)) {
        await instance.onModuleInit();
      }
    }
  }

  async callOnApplicationBootstrap(): Promise<void> {
    for (const instance of this.instances) {
      if (hasOnApplicationBootstrap(instance)) {
        await instance.onApplicationBootstrap();
      }
    }

    // Build the per-app entrypoint registry AFTER the hooks: dispatchers that
    // implement ContributesEntrypoints (WsDispatcher) finish their own
    // discovery inside onApplicationBootstrap. Built here — not in
    // VelaFactory/initRoutes — so slim bootstrap paths that never build HTTP
    // routes (the Cloudflare Durable Object) still get `app.entrypoints`.
    const discovery = this.container.has(DiscoveryService)
      ? this.container.resolve(DiscoveryService)
      : new DiscoveryService(this.container);
    this.entrypointRegistry = await EntrypointRegistry.build(discovery, this.instances);
  }

  /**
   * Every entrypoint contributed by the module graph, grouped by kind —
   * what runtime adapters/transports query instead of re-scanning providers:
   * `app.entrypoints.ofKind('websocket')`.
   */
  get entrypoints(): EntrypointRegistry {
    if (!this.entrypointRegistry) {
      throw new Error(
        'Entrypoints are not built yet — they are assembled at the end of ' +
          'callOnApplicationBootstrap(). Finish bootstrapping before querying them.',
      );
    }
    return this.entrypointRegistry;
  }

  async close(signal?: string): Promise<void> {
    const reversed = [...this.instances].reverse();

    for (const instance of reversed) {
      if (hasBeforeApplicationShutdown(instance)) {
        await instance.beforeApplicationShutdown(signal);
      }
    }

    for (const instance of reversed) {
      if (hasOnModuleDestroy(instance)) {
        await instance.onModuleDestroy();
      }
    }

    for (const instance of reversed) {
      if (hasOnApplicationShutdown(instance)) {
        await instance.onApplicationShutdown(signal);
      }
    }
  }

  /**
   * Full teardown: run shutdown lifecycle hooks ({@link close}) then dispose
   * container-held instances (LIFO) and clear cached singletons. Use for
   * graceful shutdown and dev HMR so old and new DI graphs never coexist.
   *
   * On runtimes/TS supporting explicit resource management this is also exposed
   * as `Symbol.asyncDispose`, enabling `await using app = await VelaFactory.create(...)`.
   */
  async dispose(signal?: string): Promise<void> {
    // Idempotent: `await using` + an explicit dispose(), or repeated shutdown
    // signals, must not re-run shutdown lifecycle hooks.
    if (this.disposed) return;
    this.disposed = true;
    await this.close(signal);
    await this.container.dispose();
  }
}

// Attach the well-known async-dispose symbol at runtime (it is not in the
// ES2022 lib the project compiles against) so `await using` works where
// supported, without a type dependency on esnext.disposable.
const ASYNC_DISPOSE: symbol | undefined = (Symbol as { asyncDispose?: symbol }).asyncDispose;
if (ASYNC_DISPOSE) {
  (VelaApplication.prototype as unknown as Record<PropertyKey, unknown>)[ASYNC_DISPOSE] = function (
    this: VelaApplication,
  ): Promise<void> {
    return this.dispose();
  };
}
