import type { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Container } from './container/container';
import type { Token } from './container/types';
import type { CorsOptions } from './cors/cors.types';
import type { RouteManager } from './http/route.manager';
import {
  hasBeforeApplicationShutdown,
  hasOnApplicationBootstrap,
  hasOnApplicationShutdown,
  hasOnModuleDestroy,
  hasOnModuleInit,
} from './lifecycle/index';
import type { NestMiddleware } from './pipeline/types';
import type { FilterType, GuardType, InterceptorType, MiddlewareType, PipeType } from './registry/types';

export class VelaApplication {
  private instances: unknown[] = [];
  private honoApp: Hono | null = null;
  private routesBuilt = false;

  constructor(
    private readonly container: Container,
    private readonly routeManager: RouteManager,
  ) {}

  /** Pre-build routes (handles async CRUD imports). Called by VelaFactory. */
  async initRoutes(): Promise<void> {
    this.honoApp = await this.routeManager.build();
    this.routesBuilt = true;
  }

  /**
   * Rebuild routes. Call after registering global middleware/guards/etc.
   * Not needed if you don't use useGlobalMiddleware() post-create.
   */
  async rebuild(): Promise<void> {
    this.honoApp = await this.routeManager.build();
    this.routesBuilt = true;
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

  /**
   * Set a global prefix for all routes (e.g. '/api').
   * Must be called before getHonoApp()/fetch, or call rebuild() after.
   */
  setGlobalPrefix(prefix: string): this {
    this.routeManager.setGlobalPrefix(prefix);
    return this;
  }

  /**
   * Register global middleware. Call rebuild() after if called post-create.
   * Controller/method-level @UseMiddleware works without rebuild.
   */
  useGlobalMiddleware(...middleware: MiddlewareType[]): this {
    this.routeManager.useGlobalMiddleware(...middleware);
    return this;
  }

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

  enableCors(options: CorsOptions = {}): this {
    const corsMiddleware = cors({
      origin: options.origin ?? '*',
      allowMethods: options.allowMethods,
      allowHeaders: options.allowHeaders,
      exposeHeaders: options.exposeHeaders,
      credentials: options.credentials,
      maxAge: options.maxAge,
    });
    const mw: NestMiddleware = {
      use: (c, next) => corsMiddleware(c, next) as Promise<Response | void>,
    };
    this.routeManager.useGlobalMiddleware(mw);
    return this;
  }

  get<T>(token: Token<T>): T {
    return this.container.resolve(token);
  }

  getHonoApp(): Hono {
    return this.getApp();
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
}
