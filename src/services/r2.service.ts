import { Injectable, Inject } from '@velajs/vela';
import type { BindingRef } from '../binding-ref';
import { R2_BINDING_REF } from '../tokens';

@Injectable()
export class R2Service {
  constructor(@Inject(R2_BINDING_REF) private ref: BindingRef<R2Bucket>) {}

  get bucket(): R2Bucket {
    return this.ref.value;
  }
}
