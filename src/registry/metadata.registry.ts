import type { Scope } from '../constants';
import type { InjectMetadata } from '../container/types';
import type {
  ComponentType,
  ComponentTypeMap,
  Constructor,
  FilterType,
  GuardType,
  HttpHandlerMeta,
  InterceptorType,
  MiddlewareType,
  ModuleOptions,
  ParameterMetadata,
  PipeType,
  RouteDefinition,
  Type,
} from './types';
import { getOrCreate, getOrCreateArray, getOrCreateMap } from './util';

export interface ControllerOptions {
  version?: number | number[];
}

interface ComponentStore {
  middleware: Set<MiddlewareType>;
  guard: Set<GuardType>;
  pipe: Set<PipeType>;
  interceptor: Set<InterceptorType>;
  filter: Set<FilterType>;
}

interface ComponentByOwner<O> {
  middleware: Map<O, MiddlewareType[]>;
  guard: Map<O, GuardType[]>;
  pipe: Map<O, PipeType[]>;
  interceptor: Map<O, InterceptorType[]>;
  filter: Map<O, FilterType[]>;
}

function emptyComponentStore(): ComponentStore {
  return {
    middleware: new Set(),
    guard: new Set(),
    pipe: new Set(),
    interceptor: new Set(),
    filter: new Set(),
  };
}

function emptyComponentByOwner<O>(): ComponentByOwner<O> {
  return {
    middleware: new Map(),
    guard: new Map(),
    pipe: new Map(),
    interceptor: new Map(),
    filter: new Map(),
  };
}

export class MetadataRegistry {
  // Decoration metadata (set at import time, persists across clear()).
  private static readonly routes = new Map<Constructor, RouteDefinition[]>();
  private static readonly controllers = new Map<Constructor, string>();
  private static readonly controllerOptions = new Map<Constructor, ControllerOptions>();
  private static readonly modules = new Map<Constructor, ModuleOptions>();
  private static readonly parameters = new Map<Constructor, Map<string | symbol, ParameterMetadata[]>>();
  private static readonly injectables = new Set<Constructor>();
  private static readonly scopes = new Map<Constructor, Scope>();
  private static readonly injectTokens = new Map<Constructor, InjectMetadata[]>();
  private static readonly handlerHttpMeta = new Map<Constructor, Map<string | symbol, HttpHandlerMeta>>();
  private static readonly catchTypes = new Map<Constructor, Type<Error>[]>();
  private static readonly routeVersions = new Map<Constructor, Map<string | symbol, number | number[]>>();

  // Free-form key→value class & handler meta. Backs:
  //   - @SetMetadata (custom user keys)
  //   - feature decorators (@Cron, @OnEvent, @ApiDoc, …)
  //   - the SWC shim (Reflect.metadata's design:* keys)
  //   - external Reflect.defineMetadata / Reflect.getMetadata calls.
  private static readonly classMeta = new Map<object, Map<string, unknown>>();
  private static readonly handlerMeta = new Map<object, Map<string | symbol, Map<string, unknown>>>();

  // Component decoration (set by @UseGuards/@UsePipes/etc. at decoration time).
  private static readonly controllerComponents = emptyComponentByOwner<Constructor>();
  private static readonly handlerComponents: {
    middleware: Map<Constructor, Map<string | symbol, MiddlewareType[]>>;
    guard: Map<Constructor, Map<string | symbol, GuardType[]>>;
    pipe: Map<Constructor, Map<string | symbol, PipeType[]>>;
    interceptor: Map<Constructor, Map<string | symbol, InterceptorType[]>>;
    filter: Map<Constructor, Map<string | symbol, FilterType[]>>;
  } = {
    middleware: new Map(),
    guard: new Map(),
    pipe: new Map(),
    interceptor: new Map(),
    filter: new Map(),
  };

  // Global components — app-time state (cleared by clear()).
  private static globalComponents: ComponentStore = emptyComponentStore();

  // Routes

  static getRoutes(controller: Constructor): RouteDefinition[] {
    return this.routes.get(controller) ?? [];
  }

  static addRoute(controller: Constructor, route: RouteDefinition): void {
    getOrCreateArray(this.routes, controller).push(route);
  }

  // Controllers

  static getControllerPath(controller: Constructor): string {
    return this.controllers.get(controller) ?? '';
  }

  static setControllerPath(controller: Constructor, path: string): void {
    this.controllers.set(controller, path);
  }

  static getControllerOptions(controller: Constructor): ControllerOptions {
    return this.controllerOptions.get(controller) ?? {};
  }

  static setControllerOptions(controller: Constructor, options: ControllerOptions): void {
    this.controllerOptions.set(controller, options);
  }

  // Modules

  static getModuleOptions(module: Constructor): ModuleOptions | undefined {
    return this.modules.get(module);
  }

  static setModuleOptions(module: Constructor, options: ModuleOptions): void {
    this.modules.set(module, options);
  }

  // Parameters

  static getParameters(controller: Constructor): Map<string | symbol, ParameterMetadata[]> {
    return this.parameters.get(controller) ?? new Map();
  }

  static addParameter(
    controller: Constructor,
    methodName: string | symbol,
    param: ParameterMetadata,
  ): void {
    const methodMap = getOrCreateMap(this.parameters, controller);
    getOrCreateArray(methodMap, methodName).push(param);
  }

  // Component registration — global

  static registerGlobal<T extends ComponentType>(type: T, component: ComponentTypeMap[T]): void {
    (this.globalComponents[type] as Set<ComponentTypeMap[T]>).add(component);
  }

  static getGlobal<T extends ComponentType>(type: T): Set<ComponentTypeMap[T]> {
    return this.globalComponents[type] as Set<ComponentTypeMap[T]>;
  }

  // Component registration — controller-level

  static registerController<T extends ComponentType>(
    type: T,
    controller: Constructor,
    component: ComponentTypeMap[T],
  ): void {
    const map = this.controllerComponents[type] as Map<Constructor, ComponentTypeMap[T][]>;
    getOrCreateArray(map, controller).push(component);
  }

  static getController<T extends ComponentType>(
    type: T,
    controller: Constructor,
  ): ComponentTypeMap[T][] {
    const map = this.controllerComponents[type] as Map<Constructor, ComponentTypeMap[T][]>;
    return map.get(controller) ?? [];
  }

  // Component registration — handler-level

  static registerHandler<T extends ComponentType>(
    type: T,
    controller: Constructor,
    methodName: string | symbol,
    component: ComponentTypeMap[T],
  ): void {
    const map = this.handlerComponents[type] as Map<Constructor, Map<string | symbol, ComponentTypeMap[T][]>>;
    const methodMap = getOrCreateMap(map, controller);
    getOrCreateArray(methodMap, methodName).push(component);
  }

  static getHandler<T extends ComponentType>(
    type: T,
    controller: Constructor,
    methodName: string | symbol,
  ): ComponentTypeMap[T][] {
    const map = this.handlerComponents[type] as Map<Constructor, Map<string | symbol, ComponentTypeMap[T][]>>;
    return map.get(controller)?.get(methodName) ?? [];
  }

  // DI metadata

  static markInjectable(target: object): void {
    this.injectables.add(target as Constructor);
  }

  static hasInjectable(target: object): boolean {
    return this.injectables.has(target as Constructor);
  }

  static setScope(target: object, scope: Scope): void {
    this.scopes.set(target as Constructor, scope);
  }

  static getScope(target: object): Scope | undefined {
    return this.scopes.get(target as Constructor);
  }

  static setInjectTokens(target: object, tokens: InjectMetadata[]): void {
    this.injectTokens.set(target as Constructor, tokens);
  }

  static getInjectTokens(target: object): InjectMetadata[] | undefined {
    return this.injectTokens.get(target as Constructor);
  }

  // HTTP handler metadata

  static setHandlerHttpMeta(
    controller: Constructor,
    method: string | symbol,
    meta: HttpHandlerMeta,
  ): void {
    const methodMap = getOrCreateMap(this.handlerHttpMeta, controller);
    const existing = methodMap.get(method) ?? {};
    const merged: HttpHandlerMeta = { ...existing, ...meta };
    if (meta.responseHeaders) {
      merged.responseHeaders = [...(existing.responseHeaders ?? []), ...meta.responseHeaders];
    }
    methodMap.set(method, merged);
  }

  static getHandlerHttpMeta(
    controller: Constructor,
    method: string | symbol,
  ): HttpHandlerMeta | undefined {
    return this.handlerHttpMeta.get(controller)?.get(method);
  }

  // Exception filter types

  static setCatchTypes(filter: Constructor, types: Type<Error>[]): void {
    this.catchTypes.set(filter, types);
  }

  static getCatchTypes(filter: Constructor): Type<Error>[] | undefined {
    return this.catchTypes.get(filter);
  }

  static hasCatchTypes(filter: Constructor): boolean {
    return this.catchTypes.has(filter);
  }

  // Route versions

  static setRouteVersion(
    controller: Constructor,
    method: string | symbol,
    version: number | number[],
  ): void {
    getOrCreateMap(this.routeVersions, controller).set(method, version);
  }

  static getRouteVersion(
    controller: Constructor,
    method: string | symbol,
  ): number | number[] | undefined {
    return this.routeVersions.get(controller)?.get(method);
  }

  // Custom class/handler metadata. One slot per (target, key) for class-level,
  // (target, handler, key) for handler-level. The same slots back @SetMetadata,
  // every feature decorator (@Cron, @OnEvent, @ApiDoc, …), the SWC shim, and
  // external Reflect.defineMetadata calls — one model, one source of truth.

  static setCustomClassMeta(target: object, key: string, value: unknown): void {
    getOrCreate(this.classMeta, target, () => new Map<string, unknown>()).set(key, value);
  }

  static getCustomClassMeta(target: object, key: string): unknown {
    return this.classMeta.get(target)?.get(key);
  }

  static getCustomClassMetaAll(target: object): Map<string, unknown> | undefined {
    return this.classMeta.get(target);
  }

  static setCustomHandlerMeta(
    target: object,
    handler: string | symbol,
    key: string,
    value: unknown,
  ): void {
    const byHandler = getOrCreate(this.handlerMeta, target, () => new Map<string | symbol, Map<string, unknown>>());
    getOrCreate(byHandler, handler, () => new Map<string, unknown>()).set(key, value);
  }

  static getCustomHandlerMeta(
    target: object,
    handler: string | symbol,
    key: string,
  ): unknown {
    return this.handlerMeta.get(target)?.get(handler)?.get(key);
  }

  static getCustomHandlerMetaAll(
    target: object,
    handler: string | symbol,
  ): Map<string, unknown> | undefined {
    return this.handlerMeta.get(target)?.get(handler);
  }

  // Append helpers — for stackable metadata like @Cron / @Interval / @OnEvent / @ApiResponse.

  static appendCustomClassMeta<T>(target: object, key: string, item: T): void {
    const list = (this.getCustomClassMeta(target, key) as T[] | undefined) ?? [];
    list.push(item);
    this.setCustomClassMeta(target, key, list);
  }

  static appendCustomHandlerMeta<T>(
    target: object,
    handler: string | symbol,
    key: string,
    item: T,
  ): void {
    const list = (this.getCustomHandlerMeta(target, handler, key) as T[] | undefined) ?? [];
    list.push(item);
    this.setCustomHandlerMeta(target, handler, key, list);
  }

  // Reflect-style API — same storage as the typed setters above. Lets external
  // code (and the SWC shim's Reflect.metadata polyfill) write/read uniformly.

  static setReflectMetadata(
    target: object,
    key: string,
    value: unknown,
    propertyKey?: string | symbol,
  ): void {
    if (propertyKey !== undefined) {
      this.setCustomHandlerMeta(target, propertyKey, key, value);
    } else {
      this.setCustomClassMeta(target, key, value);
    }
  }

  static getReflectMetadata<T = unknown>(
    target: object,
    key: string,
    propertyKey?: string | symbol,
  ): T | undefined {
    if (propertyKey !== undefined) {
      return this.getCustomHandlerMeta(target, propertyKey, key) as T | undefined;
    }
    return this.getCustomClassMeta(target, key) as T | undefined;
  }

  // SWC-emitted design:paramtypes — class-level for constructors, handler-level for methods.

  static getParamTypes(target: object, propertyKey?: string | symbol): unknown[] | undefined {
    return this.getReflectMetadata<unknown[]>(target, 'design:paramtypes', propertyKey);
  }

  // Propagate all controller-level components from one class to another.

  static propagateControllerComponents(from: Constructor, to: Constructor): void {
    for (const type of ['middleware', 'guard', 'pipe', 'interceptor', 'filter'] as const) {
      const map = this.controllerComponents[type];
      const components = map.get(from);
      if (components && components.length > 0) {
        const target = getOrCreateArray(map as Map<Constructor, unknown[]>, to) as unknown[];
        target.push(...components);
      }
    }
  }

  // Clear app-time state. Decoration metadata persists — once a class is
  // decorated, that fact is permanent for the lifetime of the process.

  static clear(): void {
    this.globalComponents = emptyComponentStore();
  }

  // Full reset, including decoration metadata. Used in framework-internal scenarios.

  static reset(): void {
    this.routes.clear();
    this.controllers.clear();
    this.controllerOptions.clear();
    this.modules.clear();
    this.parameters.clear();
    this.injectables.clear();
    this.scopes.clear();
    this.injectTokens.clear();
    this.handlerHttpMeta.clear();
    this.catchTypes.clear();
    this.routeVersions.clear();
    this.classMeta.clear();
    this.handlerMeta.clear();
    for (const type of ['middleware', 'guard', 'pipe', 'interceptor', 'filter'] as const) {
      this.controllerComponents[type].clear();
      this.handlerComponents[type].clear();
    }
    this.globalComponents = emptyComponentStore();
    // reflectMeta is a WeakMap — entries die with their targets.
  }
}
