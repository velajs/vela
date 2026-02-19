import 'reflect-metadata';
import { METADATA_KEYS, Scope } from '../constants.js';
import type { Type } from '../container/types.js';
import { ComponentManager } from '../pipeline/component.manager.js';
import { MetadataRegistry } from '../registry/metadata.registry.js';
import type { ResourceConfig, CrudConfig } from './types.js';

interface DynamicModule {
  module: Type;
  providers?: unknown[];
  controllers?: Type[];
}

export class CrudModule {
  static forResource(path: string, config: ResourceConfig): DynamicModule {
    // Create a unique dynamic controller class
    const controllerClass = class DynamicCrudController {};
    Object.defineProperty(controllerClass, 'name', {
      value: `CrudController_${path.replace(/[^a-zA-Z0-9]/g, '_')}`,
    });

    // Mark as injectable + controller
    Reflect.defineMetadata(METADATA_KEYS.INJECTABLE, true, controllerClass);
    Reflect.defineMetadata(METADATA_KEYS.SCOPE, Scope.SINGLETON, controllerClass);

    // Store CRUD config
    const crudConfig: CrudConfig = {
      meta: config.meta,
      adapters: config.adapters,
      only: config.only,
      except: config.except,
      endpoints: config.endpoints,
    };
    Reflect.defineMetadata(METADATA_KEYS.CRUD, crudConfig, controllerClass);

    // Store controller path in registry
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    MetadataRegistry.setControllerPath(controllerClass, normalizedPath);

    // Register guards at controller level
    if (config.guards) {
      for (const guard of config.guards) {
        ComponentManager.registerController('guard', controllerClass, guard);
      }
    }

    // Create a fresh dynamic module class for this resource
    const moduleClass = class DynamicCrudModule {};
    Object.defineProperty(moduleClass, 'name', {
      value: `CrudModule_${path.replace(/[^a-zA-Z0-9]/g, '_')}`,
    });
    Reflect.defineMetadata(METADATA_KEYS.MODULE, true, moduleClass);
    MetadataRegistry.setModuleOptions(moduleClass as unknown as Type, {
      controllers: [controllerClass as unknown as Type],
    });

    return {
      module: moduleClass as unknown as Type,
      controllers: [controllerClass as unknown as Type],
    };
  }
}
