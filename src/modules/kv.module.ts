import { createModuleRef, type DynamicModule } from '@velajs/vela';
import { BindingRef } from '../binding-ref';
import { KV_BINDING_REF, bindingsRegistry } from '../tokens';
import { KVService } from '../services/kv.service';

export class KVModule {
  static forRoot(options: { binding: string }): DynamicModule {
    const ref = new BindingRef(options.binding);
    bindingsRegistry.push(ref);

    return {
      module: createModuleRef(`KVModule_${options.binding}`),
      providers: [
        { provide: KV_BINDING_REF, useValue: ref },
        KVService,
      ],
      exports: [KVService, KV_BINDING_REF],
    };
  }
}
