import { MetadataRegistry } from '@velajs/vela';
import type { Type, DynamicModule } from '@velajs/vela';
import { BindingRef } from '../binding-ref';
import { AI_BINDING_REF, bindingsRegistry } from '../tokens';
import { AIService } from '../services/ai.service';

export class AIModule {
  static forRoot(options: { binding: string }): DynamicModule {
    const ref = new BindingRef(options.binding);
    bindingsRegistry.push(ref);

    const moduleClass = class AIDynamicModule {};
    Object.defineProperty(moduleClass, 'name', {
      value: `AIModule_${options.binding}`,
    });
    MetadataRegistry.setModuleOptions(moduleClass as unknown as Type, {
      exports: [AIService, AI_BINDING_REF],
    });

    return {
      module: moduleClass as unknown as Type,
      providers: [
        { token: AI_BINDING_REF, useValue: ref },
        AIService,
      ],
    };
  }
}
