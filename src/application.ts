import type { Hono } from 'hono';
import type { Container } from './container/container';
import type { Token } from './container/types';
import type { RouteManager } from './http/route.manager';
import {
  hasBeforeApplicationShutdown,
  hasOnApplicationBootstrap,
  hasOnApplicationShutdown,
  hasOnModuleDestroy,
  hasOnModuleInit,
} from './lifecycle/index';
import type { FilterType, GuardType, InterceptorType, PipeType } from './registry/types';

export class VelaApplication {
  private instances: unknown[] = [];
  private honoApp: Hono | null = null;

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
