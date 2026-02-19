import type {
  ComponentInstance,
  ComponentType,
  ComponentTypeMap,
  Constructor,
  ModuleOptions,
  ParameterMetadata,
  RouteDefinition,
} from './types.js';

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
  }
}
