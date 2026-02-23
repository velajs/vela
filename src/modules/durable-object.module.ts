import { MetadataRegistry } from '@velajs/vela';
import type { Type, DynamicModule } from '@velajs/vela';
import { BindingRef } from '../binding-ref';
import { DO_BINDING_REF, bindingsRegistry } from '../tokens';
import { DurableObjectService } from '../services/durable-object.service';

export class DurableObjectModule {
  static forRoot(options: { binding: string }): DynamicModule {
    const ref = new BindingRef(options.binding);
    bindingsRegistry.push(ref);

    const moduleClass = class DurableObjectDynamicModule {};
    Object.defineProperty(moduleClass, 'name', {
      value: `DurableObjectModule_${options.binding}`,
    });
    MetadataRegistry.setModuleOptions(moduleClass as unknown as Type, {
      exports: [DurableObjectService, DO_BINDING_REF],
    });

    return {
      module: moduleClass as unknown as Type,
      providers: [
        { token: DO_BINDING_REF, useValue: ref },
        DurableObjectService,
      ],
    };
  }
}
