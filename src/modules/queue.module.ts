import { createModuleRef, type DynamicModule } from '@velajs/vela';
import { BindingRef } from '../binding-ref';
import { QUEUE_BINDING_REF, bindingsRegistry } from '../tokens';
import { QueueService } from '../services/queue.service';

export class QueueModule {
  static forRoot(options: { binding: string }): DynamicModule {
    const ref = new BindingRef(options.binding);
    bindingsRegistry.push(ref);

    return {
      module: createModuleRef(`QueueModule_${options.binding}`),
      providers: [
        { provide: QUEUE_BINDING_REF, useValue: ref },
        QueueService,
      ],
      exports: [QueueService, QUEUE_BINDING_REF],
    };
  }
}
