import { createModuleRef, type DynamicModule } from '@velajs/vela';
import { BindingRef } from '../binding-ref';
import { D1_BINDING_REF, bindingsRegistry } from '../tokens';
import { D1Service } from '../services/d1.service';

export class D1Module {
  static forRoot(options: { binding: string }): DynamicModule {
    const ref = new BindingRef(options.binding);
    bindingsRegistry.push(ref);

    return {
      module: createModuleRef(`D1Module_${options.binding}`),
      providers: [
        { provide: D1_BINDING_REF, useValue: ref },
        D1Service,
      ],
      exports: [D1Service, D1_BINDING_REF],
    };
  }
}
