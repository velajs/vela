import { Injectable, Inject } from '@velajs/vela';
import type { BindingRef } from '../binding-ref';
import { QUEUE_BINDING_REF } from '../tokens';

@Injectable()
export class QueueService<Body = unknown> {
  constructor(@Inject(QUEUE_BINDING_REF) private ref: BindingRef<Queue<Body>>) {}

  get queue(): Queue<Body> {
    return this.ref.value;
  }
}
