import { createModuleRef, type DynamicModule } from '@velajs/vela';
import { BindingRef } from '../binding-ref';
import { HYPERDRIVE_BINDING_REF, bindingsRegistry } from '../tokens';
import { HyperdriveService } from '../services/hyperdrive.service';

export class HyperdriveModule {
  static forRoot(options: { binding: string }): DynamicModule {
    const ref = new BindingRef(options.binding);
    bindingsRegistry.push(ref);

    return {
      module: createModuleRef(`HyperdriveModule_${options.binding}`),
      providers: [
        { provide: HYPERDRIVE_BINDING_REF, useValue: ref },
        HyperdriveService,
      ],
      exports: [HyperdriveService, HYPERDRIVE_BINDING_REF],
    };
  }
}
