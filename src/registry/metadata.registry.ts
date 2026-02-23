import type { Scope } from '../constants';
import type { InjectMetadata } from '../container/types';
import type { Type } from '../container/types';
import type {
  ComponentInstance,
  ComponentType,
  ComponentTypeMap,
  Constructor,
  HttpHandlerMeta,
  ModuleOptions,
  ParameterMetadata,
  RouteDefinition,
} from './types';

export interface ControllerOptions {
  version?: number | number[];
}

export class MetadataRegistry {
  private static readonly routes = new Map<Constructor, RouteDefinition[]>();
  private static readonly controllers = new Map<Constructor, string>();
  private static readonly controllerOptions = new Map<Constructor, ControllerOptions>();
  private static readonly modules = new Map<Constructor, ModuleOptions>();
  private static readonly parameters = new Map<Constructor, Map<string | symbol, ParameterMetadata[]>>();

  // 3-level component hierarchy
  private static readonly global = new Map<ComponentType, Set<ComponentInstance>>([
    ['middleware', new Set()],
    ['guard', new Set()],
    ['pipe', new Set()],
    ['interceptor', new Set()],
    ['filter', new Set()],
  ]);

  private static readonly controller = new Map<ComponentType, Map<Constructor, ComponentInstance[]>>([
    ['middleware', new Map()],
    ['guard', new Map()],
    ['pipe', new Map()],
    ['interceptor', new Map()],
    ['filter', new Map()],
  ]);

  private static readonly handler = new Map<ComponentType, Map<string, ComponentInstance[]>>([
    ['middleware', new Map()],
    ['guard', new Map()],
    ['pipe', new Map()],
    ['interceptor', new Map()],
    ['filter', new Map()],
  ]);

  // DI metadata
  private static readonly injectables = new Set<Constructor>();
  private static readonly scopes = new Map<Constructor, Scope>();
  private static readonly injectTokens = new Map<Constructor, InjectMetadata[]>();

  // HTTP handler metadata
  private static readonly handlerHttpMeta = new Map<Constructor, Map<string | symbol, HttpHandlerMeta>>();

  // Exception filter types
  private static readonly catchTypes = new Map<Constructor, Type<Error>[]>();

  // Route versions
  private static readonly routeVersions = new Map<Constructor, Map<string | symbol, number | number[]>>();

  // Custom metadata (SetMetadata)
  private static readonly customClassMeta = new Map<Constructor, Map<string, unknown>>();
  private static readonly customHandlerMeta = new Map<Constructor, Map<string | symbol, Map<string, unknown>>>();

  // Routes

  static getRoutes(controller: Constructor): RouteDefinition[] {
    return this.routes.get(controller) || [];
  }

  static addRoute(controller: Constructor, route: RouteDefinition): void {
    if (!this.routes.has(controller)) {
      this.routes.set(controller, []);
    }
    this.routes.get(controller)!.push(route);
  }

  // Controllers

  static getControllerPath(controller: Constructor): string {
    return this.controllers.get(controller) || '';
  }

  static setControllerPath(controller: Constructor, path: string): void {
    this.controllers.set(controller, path);
  }

  static getControllerOptions(controller: Constructor): ControllerOptions {
    return this.controllerOptions.get(controller) || {};
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
    return this.parameters.get(controller) || new Map();
  }

  static addParameter(
    controller: Constructor,
    methodName: string | symbol,
    param: ParameterMetadata,
  ): void {
    if (!this.parameters.has(controller)) {
      this.parameters.set(controller, new Map());
    }
    const methodParams = this.parameters.get(controller)!;
    if (!methodParams.has(methodName)) {
      methodParams.set(methodName, []);
    }
    methodParams.get(methodName)!.push(param);
  }

  // Component registration — 3 levels

  static registerGlobal<T extends ComponentType>(type: T, component: ComponentTypeMap[T]): void {
    this.global.get(type)!.add(component as ComponentInstance);
  }

  static getGlobal<T extends ComponentType>(type: T): Set<ComponentTypeMap[T]> {
    return this.global.get(type) as unknown as Set<ComponentTypeMap[T]>;
  }

  static registerController<T extends ComponentType>(
    type: T,
    controller: Constructor,
    component: ComponentTypeMap[T],
  ): void {
    const typeMap = this.controller.get(type)!;
    if (!typeMap.has(controller)) {
      typeMap.set(controller, []);
    }
    typeMap.get(controller)!.push(component as ComponentInstance);
  }

  static getController<T extends ComponentType>(
    type: T,
    controller: Constructor,
  ): ComponentTypeMap[T][] {
    const typeMap = this.controller.get(type)!;
    return (typeMap.get(controller) || []) as unknown as ComponentTypeMap[T][];
  }

  static registerHandler<T extends ComponentType>(
    type: T,
    handlerKey: string,
    component: ComponentTypeMap[T],
  ): void {
    const typeMap = this.handler.get(type)!;
    if (!typeMap.has(handlerKey)) {
      typeMap.set(handlerKey, []);
    }
    typeMap.get(handlerKey)!.push(component as ComponentInstance);
  }

  static getHandler<T extends ComponentType>(
    type: T,
    handlerKey: string,
  ): ComponentTypeMap[T][] {
    const typeMap = this.handler.get(type)!;
    return (typeMap.get(handlerKey) || []) as unknown as ComponentTypeMap[T][];
  }

  // DI metadata

  static markInjectable(target: Constructor): void {
    this.injectables.add(target);
  }

  static hasInjectable(target: Constructor): boolean {
    return this.injectables.has(target);
  }

  static setScope(target: Constructor, scope: Scope): void {
    this.scopes.set(target, scope);
  }

  static getScope(target: Constructor): Scope | undefined {
    return this.scopes.get(target);
  }

  static setInjectTokens(target: Constructor, tokens: InjectMetadata[]): void {
    this.injectTokens.set(target, tokens);
  }

  static getInjectTokens(target: Constructor): InjectMetadata[] | undefined {
    return this.injectTokens.get(target);
  }

  // HTTP handler metadata

  static setHandlerHttpMeta(
    controller: Constructor,
    method: string | symbol,
    meta: HttpHandlerMeta,
  ): void {
    if (!this.handlerHttpMeta.has(controller)) {
      this.handlerHttpMeta.set(controller, new Map());
    }
    const methodMap = this.handlerHttpMeta.get(controller)!;
    const existing = methodMap.get(method) ?? {};
    // Append-merge responseHeaders
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
    if (!this.routeVersions.has(controller)) {
      this.routeVersions.set(controller, new Map());
    }
    this.routeVersions.get(controller)!.set(method, version);
  }

  static getRouteVersion(
    controller: Constructor,
    method: string | symbol,
  ): number | number[] | undefined {
    return this.routeVersions.get(controller)?.get(method);
  }

  // Custom metadata (SetMetadata)

  static setCustomClassMeta(target: Constructor, key: string, value: unknown): void {
    if (!this.customClassMeta.has(target)) {
      this.customClassMeta.set(target, new Map());
    }
    this.customClassMeta.get(target)!.set(key, value);
  }

  static getCustomClassMeta(target: Constructor, key: string): unknown {
    return this.customClassMeta.get(target)?.get(key);
  }

  static getCustomClassMetaAll(target: Constructor): Map<string, unknown> | undefined {
    return this.customClassMeta.get(target);
  }

  static setCustomHandlerMeta(
    target: Constructor,
    handler: string | symbol,
    key: string,
    value: unknown,
  ): void {
    if (!this.customHandlerMeta.has(target)) {
      this.customHandlerMeta.set(target, new Map());
    }
    const handlerMap = this.customHandlerMeta.get(target)!;
    if (!handlerMap.has(handler)) {
      handlerMap.set(handler, new Map());
    }
    handlerMap.get(handler)!.set(key, value);
  }

  static getCustomHandlerMeta(
    target: Constructor,
    handler: string | symbol,
    key: string,
  ): unknown {
    return this.customHandlerMeta.get(target)?.get(handler)?.get(key);
  }

  static getCustomHandlerMetaAll(
    target: Constructor,
    handler: string | symbol,
  ): Map<string, unknown> | undefined {
    return this.customHandlerMeta.get(target)?.get(handler);
  }

  // Clear all (for testing)

  static clear(): void {
    this.routes.clear();
    this.controllers.clear();
    this.controllerOptions.clear();
    this.modules.clear();
    this.parameters.clear();

    for (const set of this.global.values()) {
      set.clear();
    }
    for (const map of this.controller.values()) {
      map.clear();
    }
    for (const map of this.handler.values()) {
      map.clear();
    }

    this.injectables.clear();
    this.scopes.clear();
    this.injectTokens.clear();
    this.handlerHttpMeta.clear();
    this.catchTypes.clear();
    this.routeVersions.clear();
    this.customClassMeta.clear();
    this.customHandlerMeta.clear();
  }
}
