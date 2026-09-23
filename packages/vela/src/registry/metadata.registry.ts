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

interface ComponentByOwner<O> {
  middleware: Map<O, MiddlewareType[]>;
  guard: Map<O, GuardType[]>;
  pipe: Map<O, PipeType[]>;
  interceptor: Map<O, InterceptorType[]>;
  filter: Map<O, FilterType[]>;
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

type HandlerComponentStore = {
  middleware: Map<Constructor, Map<string | symbol, MiddlewareType[]>>;
  guard: Map<Constructor, Map<string | symbol, GuardType[]>>;
  pipe: Map<Constructor, Map<string | symbol, PipeType[]>>;
  interceptor: Map<Constructor, Map<string | symbol, InterceptorType[]>>;
  filter: Map<Constructor, Map<string | symbol, FilterType[]>>;
};

interface RegistryState {
  routes: Map<Constructor, RouteDefinition[]>;
  controllers: Map<Constructor, string>;
  controllerOptions: Map<Constructor, ControllerOptions>;
  modules: Map<Constructor, ModuleOptions>;
  parameters: Map<Constructor, Map<string | symbol, ParameterMetadata[]>>;
  injectables: Set<Constructor>;
  scopes: Map<Constructor, Scope>;
  injectTokens: Map<Constructor, InjectMetadata[]>;
  handlerHttpMeta: Map<Constructor, Map<string | symbol, HttpHandlerMeta>>;
  catchTypes: Map<Constructor, Type<Error>[]>;
  routeVersions: Map<Constructor, Map<string | symbol, number | number[]>>;
  classMeta: Map<object, Map<string, unknown>>;
  handlerMeta: Map<object, Map<string | symbol, Map<string, unknown>>>;
  // Reverse indexes: metadata key -> targets carrying it. Backs DiscoveryService
  // so metadata-driven discovery never scans every container token. `design:*`
  // keys (SWC-emitted type info) are excluded — high-volume, never discovered.
  classMetaIndex: Map<string, Set<object>>;
  handlerMetaIndex: Map<string, Set<object>>;
  controllerComponents: ComponentByOwner<Constructor>;
  handlerComponents: HandlerComponentStore;
  // Next default key for Reflector.createDecorator. Never reset: decorators
  // created earlier keep their keys for the lifetime of the process.
  nextDecoratorKey: number;
}

function createRegistryState(): RegistryState {
  return {
    routes: new Map(),
    controllers: new Map(),
    controllerOptions: new Map(),
    modules: new Map(),
    parameters: new Map(),
    injectables: new Set(),
    scopes: new Map(),
    injectTokens: new Map(),
    handlerHttpMeta: new Map(),
    catchTypes: new Map(),
    routeVersions: new Map(),
    classMeta: new Map(),
    handlerMeta: new Map(),
    classMetaIndex: new Map(),
    handlerMetaIndex: new Map(),
    controllerComponents: emptyComponentByOwner<Constructor>(),
    handlerComponents: {
      middleware: new Map(),
      guard: new Map(),
      pipe: new Map(),
      interceptor: new Map(),
      filter: new Map(),
    },
    nextDecoratorKey: 0,
  };
}

// HMR-safe: anchor ALL backing state on `globalThis` so a Vite dev re-eval of
// this module reuses the SAME maps that classes were already decorated against.
// Without this, re-eval creates fresh empty statics → split-brain (lost routes,
// spurious "not @Injectable" warnings, duplicated global components). The
// versioned symbol avoids collisions across framework major versions in one
// process. `globalThis` + `Symbol.for` exist on every target runtime; no node:*.
const REGISTRY_STATE_KEY = Symbol.for('vela:registry:v1');

// Shared empty result for index misses — avoids allocating per lookup.
const EMPTY_TARGET_SET: ReadonlySet<object> = new Set<object>();

function registryState(): RegistryState {
  const g = globalThis as unknown as Record<symbol, RegistryState | undefined>;
  const state = (g[REGISTRY_STATE_KEY] ??= createRegistryState());
  // Backfill fields added after the v1 state shape was first anchored: a state
  // created by an older copy of this module (dist/src coexistence in tests,
  // mixed package versions in one process) must not crash newer readers.
  state.classMetaIndex ??= new Map();
  state.handlerMetaIndex ??= new Map();
  state.nextDecoratorKey ??= 0;
  return state;
}

/**
 * Allocate a default metadata key for `Reflector.createDecorator`. The counter
 * lives in the globalThis-anchored state, so duplicated package copies and HMR
 * re-evaluation never hand out the same key twice. Unlike random values, it is
 * also allowed in workerd's global scope, where decorators are declared.
 */
export function allocateDecoratorKey(): string {
  const state = registryState();
  return `vela:custom:${state.nextDecoratorKey++}`;
}

/**
 * Distinct classes (and handler owners) the isolate-global registry holds
 * metadata for. Decoration is permanent, so this only grows; tests use it to
 * prove a code path declares nothing new, such as rebuilding an application.
 */
export function countRegisteredClasses(): number {
  const state = registryState();
  const targets = new Set<object>();
  const perClass: ReadonlyArray<Map<object, unknown> | Set<object>> = [
    state.routes,
    state.controllers,
    state.controllerOptions,
    state.modules,
    state.parameters,
    state.injectables,
    state.scopes,
    state.injectTokens,
    state.handlerHttpMeta,
    state.catchTypes,
    state.routeVersions,
    state.classMeta,
    state.handlerMeta,
    ...Object.values(state.controllerComponents),
    ...Object.values(state.handlerComponents),
  ];
  for (const store of perClass) for (const target of store.keys()) targets.add(target);
  return targets.size;
}

export class MetadataRegistry {
  // Every field is a getter over the globalThis-anchored state (registryState).
  // Method bodies keep using `this.<field>`; the getter returns the live map so
  // `.set`/`.get`/`.clear` mutate the shared state.
  private static get routes(): RegistryState['routes'] {
    return registryState().routes;
  }
  private static get controllers(): RegistryState['controllers'] {
    return registryState().controllers;
  }
  private static get controllerOptions(): RegistryState['controllerOptions'] {
    return registryState().controllerOptions;
  }
  private static get modules(): RegistryState['modules'] {
    return registryState().modules;
  }
  private static get parameters(): RegistryState['parameters'] {
    return registryState().parameters;
  }
  private static get injectables(): RegistryState['injectables'] {
    return registryState().injectables;
  }
  private static get scopes(): RegistryState['scopes'] {
    return registryState().scopes;
  }
  private static get injectTokens(): RegistryState['injectTokens'] {
    return registryState().injectTokens;
  }
  private static get handlerHttpMeta(): RegistryState['handlerHttpMeta'] {
    return registryState().handlerHttpMeta;
  }
  private static get catchTypes(): RegistryState['catchTypes'] {
    return registryState().catchTypes;
  }
  private static get routeVersions(): RegistryState['routeVersions'] {
    return registryState().routeVersions;
  }
  private static get classMeta(): RegistryState['classMeta'] {
    return registryState().classMeta;
  }
  private static get handlerMeta(): RegistryState['handlerMeta'] {
    return registryState().handlerMeta;
  }
  private static get classMetaIndex(): RegistryState['classMetaIndex'] {
    return registryState().classMetaIndex;
  }
  private static get handlerMetaIndex(): RegistryState['handlerMetaIndex'] {
    return registryState().handlerMetaIndex;
  }
  private static get controllerComponents(): RegistryState['controllerComponents'] {
    return registryState().controllerComponents;
  }
  private static get handlerComponents(): RegistryState['handlerComponents'] {
    return registryState().handlerComponents;
  }

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

  // Component registration — class-level, for controllers and modules alike.
  // A module class's entries apply to that module's controllers through the
  // per-app module scope (see getScopedComponents), never by copying them here.
  // (There is deliberately NO global tier here: app-wide components live on
  // the per-app RouteManager, one source, never process-global state.)

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
    const map = this.handlerComponents[type] as Map<
      Constructor,
      Map<string | symbol, ComponentTypeMap[T][]>
    >;
    const methodMap = getOrCreateMap(map, controller);
    getOrCreateArray(methodMap, methodName).push(component);
  }

  static getHandler<T extends ComponentType>(
    type: T,
    controller: Constructor,
    methodName: string | symbol,
  ): ComponentTypeMap[T][] {
    const map = this.handlerComponents[type] as Map<
      Constructor,
      Map<string | symbol, ComponentTypeMap[T][]>
    >;
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
    if (!key.startsWith('design:')) {
      getOrCreate(this.classMetaIndex, key, () => new Set<object>()).add(target);
    }
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
    const byHandler = getOrCreate(
      this.handlerMeta,
      target,
      () => new Map<string | symbol, Map<string, unknown>>(),
    );
    getOrCreate(byHandler, handler, () => new Map<string, unknown>()).set(key, value);
    if (!key.startsWith('design:')) {
      getOrCreate(this.handlerMetaIndex, key, () => new Set<object>()).add(target);
    }
  }

  static getCustomHandlerMeta(target: object, handler: string | symbol, key: string): unknown {
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

  // Reverse-index readers — the DiscoveryService seam. Return the constructors
  // known to carry class-level (resp. handler-level) metadata under `key`.
  // Callers must still intersect with container-registered tokens: decoration
  // alone does not make a class a provider.

  static getClassesWithClassMeta(key: string): ReadonlySet<object> {
    return this.classMetaIndex.get(key) ?? EMPTY_TARGET_SET;
  }

  static getClassesWithHandlerMeta(key: string): ReadonlySet<object> {
    return this.handlerMetaIndex.get(key) ?? EMPTY_TARGET_SET;
  }

  /** Every (handler, value) pair on `target` carrying metadata under `key`. */
  static getHandlersWithMeta(
    target: object,
    key: string,
  ): Array<{ handler: string | symbol; value: unknown }> {
    const byHandler = this.handlerMeta.get(target);
    if (!byHandler) return [];
    const out: Array<{ handler: string | symbol; value: unknown }> = [];
    for (const [handler, metaMap] of byHandler) {
      if (metaMap.has(key)) out.push({ handler, value: metaMap.get(key) });
    }
    return out;
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

  // Decoration metadata is permanent for the lifetime of the process, and the
  // registry holds no application state: each application keeps its own in its
  // container and RouteManager, so nothing needs clearing between tests.

  /**
   * Full reset, including decoration metadata. Framework-internal: only
   * suites that re-evaluate decorators may call it (see `@velajs/vela/internal`).
   */
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
    this.classMetaIndex.clear();
    this.handlerMetaIndex.clear();
    for (const type of ['middleware', 'guard', 'pipe', 'interceptor', 'filter'] as const) {
      this.controllerComponents[type].clear();
      this.handlerComponents[type].clear();
    }
  }
}
