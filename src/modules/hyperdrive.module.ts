import { MetadataRegistry } from '@velajs/vela';
import type { Type, DynamicModule } from '@velajs/vela';
import { BindingRef } from '../binding-ref';
import { HYPERDRIVE_BINDING_REF, bindingsRegistry } from '../tokens';
import { HyperdriveService } from '../services/hyperdrive.service';

export class HyperdriveModule {
  static forRoot(options: { binding: string }): DynamicModule {
    const ref = new BindingRef(options.binding);
    bindingsRegistry.push(ref);

    const moduleClass = class HyperdriveDynamicModule {};
    Object.defineProperty(moduleClass, 'name', {
      value: `HyperdriveModule_${options.binding}`,
    });
    MetadataRegistry.setModuleOptions(moduleClass as unknown as Type, {
      exports: [HyperdriveService, HYPERDRIVE_BINDING_REF],
    });

    return {
      module: moduleClass as unknown as Type,
      providers: [
        { token: HYPERDRIVE_BINDING_REF, useValue: ref },
        HyperdriveService,
      ],
    };
  }
}
