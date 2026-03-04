import { MetadataRegistry } from '@velajs/vela';
import type { Type, DynamicModule } from '@velajs/vela';
import { BindingRef } from '../binding-ref';
import { D1_BINDING_REF, bindingsRegistry } from '../tokens';
import { D1Service } from '../services/d1.service';

export class D1Module {
  static forRoot(options: { binding: string }): DynamicModule {
    const ref = new BindingRef(options.binding);
    bindingsRegistry.push(ref);

    const moduleClass = class D1DynamicModule {};
    Object.defineProperty(moduleClass, 'name', {
      value: `D1Module_${options.binding}`,
    });
    MetadataRegistry.setModuleOptions(moduleClass as unknown as Type, {
      exports: [D1Service, D1_BINDING_REF],
    });

    return {
      module: moduleClass as unknown as Type,
      providers: [
        { provide: D1_BINDING_REF, useValue: ref },
        D1Service,
      ],
    };
  }
}
