import 'reflect-metadata';
import { METADATA_KEYS, MetadataRegistry } from '@velajs/vela';
import type { Type, DynamicModule } from '@velajs/vela';
import { BindingRef } from '../binding-ref';
import { KV_BINDING_REF, bindingsRegistry } from '../tokens';
import { KVService } from '../services/kv.service';

export class KVModule {
  static forRoot(options: { binding: string }): DynamicModule {
    const ref = new BindingRef(options.binding);
    bindingsRegistry.push(ref);

    const moduleClass = class KVDynamicModule {};
    Object.defineProperty(moduleClass, 'name', {
      value: `KVModule_${options.binding}`,
    });
    Reflect.defineMetadata(METADATA_KEYS.MODULE, true, moduleClass);
    MetadataRegistry.setModuleOptions(moduleClass as unknown as Type, {
      exports: [KVService, KV_BINDING_REF],
    });

    return {
      module: moduleClass as unknown as Type,
      providers: [
        { token: KV_BINDING_REF, useValue: ref },
        KVService,
      ],
    };
  }
}
