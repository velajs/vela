import { createModuleRef, type DynamicModule } from '@velajs/vela';
import { BindingRef } from '../binding-ref';
import { R2_BINDING_REF, bindingsRegistry } from '../tokens';
import { R2Service } from '../services/r2.service';

export class R2Module {
  static forRoot(options: { binding: string }): DynamicModule {
    const ref = new BindingRef(options.binding);
    bindingsRegistry.push(ref);

    return {
      module: createModuleRef(`R2Module_${options.binding}`),
      providers: [
        { provide: R2_BINDING_REF, useValue: ref },
        R2Service,
      ],
      exports: [R2Service, R2_BINDING_REF],
    };
  }
}
