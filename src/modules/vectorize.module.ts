import 'reflect-metadata';
import { METADATA_KEYS, MetadataRegistry } from '@velajs/vela';
import type { Type, DynamicModule } from '@velajs/vela';
import { BindingRef } from '../binding-ref';
import { VECTORIZE_BINDING_REF, bindingsRegistry } from '../tokens';
import { VectorizeService } from '../services/vectorize.service';

export class VectorizeModule {
  static forRoot(options: { binding: string }): DynamicModule {
    const ref = new BindingRef(options.binding);
    bindingsRegistry.push(ref);

    const moduleClass = class VectorizeDynamicModule {};
    Object.defineProperty(moduleClass, 'name', {
      value: `VectorizeModule_${options.binding}`,
    });
    Reflect.defineMetadata(METADATA_KEYS.MODULE, true, moduleClass);
    MetadataRegistry.setModuleOptions(moduleClass as unknown as Type, {
      exports: [VectorizeService, VECTORIZE_BINDING_REF],
    });

    return {
      module: moduleClass as unknown as Type,
      providers: [
        { token: VECTORIZE_BINDING_REF, useValue: ref },
        VectorizeService,
      ],
    };
  }
}
