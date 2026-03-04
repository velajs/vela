import { createModuleRef, type DynamicModule } from '@velajs/vela';
import { BindingRef } from '../binding-ref';
import { DO_BINDING_REF, bindingsRegistry } from '../tokens';
import { DurableObjectService } from '../services/durable-object.service';

export class DurableObjectModule {
  static forRoot(options: { binding: string }): DynamicModule {
    const ref = new BindingRef(options.binding);
    bindingsRegistry.push(ref);

    return {
      module: createModuleRef(`DurableObjectModule_${options.binding}`),
      providers: [
        { provide: DO_BINDING_REF, useValue: ref },
        DurableObjectService,
      ],
      exports: [DurableObjectService, DO_BINDING_REF],
    };
  }
}
