import { METADATA_KEYS, Scope, ComponentManager, MetadataRegistry, defineMetadata, createModuleRef } from '@velajs/vela';
import type { Type, DynamicModule } from '@velajs/vela';
import type { ResourceConfig, CrudConfig } from './types';

export class CrudModule {
  static forResource(path: string, config: ResourceConfig): DynamicModule {
    // Create a unique dynamic controller class
    const controllerClass = class DynamicCrudController {};
    Object.defineProperty(controllerClass, 'name', {
      value: `CrudController_${path.replace(/[^a-zA-Z0-9]/g, '_')}`,
    });

    // Mark as injectable + controller
    MetadataRegistry.markInjectable(controllerClass);
    MetadataRegistry.setScope(controllerClass, Scope.SINGLETON);

    // Store CRUD config
    const crudConfig: CrudConfig = {
      meta: config.meta,
      adapters: config.adapters,
      only: config.only,
      except: config.except,
      endpoints: config.endpoints,
    };
    defineMetadata(METADATA_KEYS.CRUD, crudConfig, controllerClass);

    // Store controller path in registry
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    MetadataRegistry.setControllerPath(controllerClass, normalizedPath);

    // Register guards at controller level
    if (config.guards) {
      for (const guard of config.guards) {
        ComponentManager.registerController('guard', controllerClass, guard);
      }
    }

    return {
      module: createModuleRef(`CrudModule_${path.replace(/[^a-zA-Z0-9]/g, '_')}`),
      controllers: [controllerClass as unknown as Type],
    };
  }
}
