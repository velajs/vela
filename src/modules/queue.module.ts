import { QueueService } from '../services/queue.service';
import { QUEUE_BINDING_REF } from '../tokens';
import { createBindingModule } from './create-binding-module';

export const QueueModule = createBindingModule({
  name: 'Queue',
  serviceClass: QueueService,
  bindingRefToken: QUEUE_BINDING_REF,
});
