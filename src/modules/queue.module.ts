import { MetadataRegistry } from '@velajs/vela';
import type { Type, DynamicModule } from '@velajs/vela';
import { BindingRef } from '../binding-ref';
import { QUEUE_BINDING_REF, bindingsRegistry } from '../tokens';
import { QueueService } from '../services/queue.service';

export class QueueModule {
  static forRoot(options: { binding: string }): DynamicModule {
    const ref = new BindingRef(options.binding);
    bindingsRegistry.push(ref);

    const moduleClass = class QueueDynamicModule {};
    Object.defineProperty(moduleClass, 'name', {
      value: `QueueModule_${options.binding}`,
    });
    MetadataRegistry.setModuleOptions(moduleClass as unknown as Type, {
      exports: [QueueService, QUEUE_BINDING_REF],
    });

    return {
      module: moduleClass as unknown as Type,
      providers: [
        { provide: QUEUE_BINDING_REF, useValue: ref },
        QueueService,
      ],
    };
  }
}
