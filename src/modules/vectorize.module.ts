import { createModuleRef, type DynamicModule } from '@velajs/vela';
import { BindingRef } from '../binding-ref';
import { VECTORIZE_BINDING_REF, bindingsRegistry } from '../tokens';
import { VectorizeService } from '../services/vectorize.service';

export class VectorizeModule {
  static forRoot(options: { binding: string }): DynamicModule {
    const ref = new BindingRef(options.binding);
    bindingsRegistry.push(ref);

    return {
      module: createModuleRef(`VectorizeModule_${options.binding}`),
      providers: [
        { provide: VECTORIZE_BINDING_REF, useValue: ref },
        VectorizeService,
      ],
      exports: [VectorizeService, VECTORIZE_BINDING_REF],
    };
  }
}
