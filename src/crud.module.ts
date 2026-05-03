import { METADATA_KEYS, MetadataRegistry, Scope, defineMetadata } from '@velajs/vela';
import { ComponentManager } from '@velajs/vela/internal';
import type { Type, DynamicModule } from '@velajs/vela';
import type { ResourceConfig, CrudConfig } from './types';

export class CrudModule {
  static forResource(path: string, config: ResourceConfig): DynamicModule {
    // Synthetic per-resource controller class. Vela's audit #2 removed
    // `createModuleRef`, but controllers still need a unique class identity per
    // resource path so the registry can store path/CRUD metadata independently.
    //
    // Computed-property-name idiom: NamedEvaluation reads the property key
    // and stamps `name` on the class at creation, no post-hoc property
    // mutation, no cast.
    const controllerName = `CrudController_${path.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const controllerClass: Type = { [controllerName]: class {} }[controllerName];

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

    // Per audit #2: the synthetic module-class trick is replaced by the
    // explicit `key` discriminator. Two `forResource(path)` calls with the
    // same path dedup (same module + same key); different paths register as
    // distinct module instances.
    return {
      module: CrudModule,
      key: normalizedPath,
      controllers: [controllerClass],
    };
  }
}
