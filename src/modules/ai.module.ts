import { createModuleRef, type DynamicModule } from '@velajs/vela';
import { BindingRef } from '../binding-ref';
import { AI_BINDING_REF, bindingsRegistry } from '../tokens';
import { AIService } from '../services/ai.service';

export class AIModule {
  static forRoot(options: { binding: string }): DynamicModule {
    const ref = new BindingRef(options.binding);
    bindingsRegistry.push(ref);

    return {
      module: createModuleRef(`AIModule_${options.binding}`),
      providers: [
        { provide: AI_BINDING_REF, useValue: ref },
        AIService,
      ],
      exports: [AIService, AI_BINDING_REF],
    };
  }
}
