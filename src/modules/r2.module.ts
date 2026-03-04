import { MetadataRegistry } from '@velajs/vela';
import type { Type, DynamicModule } from '@velajs/vela';
import { BindingRef } from '../binding-ref';
import { R2_BINDING_REF, bindingsRegistry } from '../tokens';
import { R2Service } from '../services/r2.service';

export class R2Module {
  static forRoot(options: { binding: string }): DynamicModule {
    const ref = new BindingRef(options.binding);
    bindingsRegistry.push(ref);

    const moduleClass = class R2DynamicModule {};
    Object.defineProperty(moduleClass, 'name', {
      value: `R2Module_${options.binding}`,
    });
    MetadataRegistry.setModuleOptions(moduleClass as unknown as Type, {
      exports: [R2Service, R2_BINDING_REF],
    });

    return {
      module: moduleClass as unknown as Type,
      providers: [
        { provide: R2_BINDING_REF, useValue: ref },
        R2Service,
      ],
    };
  }
}
