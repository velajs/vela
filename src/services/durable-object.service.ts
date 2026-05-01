import { Injectable, Inject } from '@velajs/vela';
import type { BindingRef } from '../binding-ref';
import { DO_BINDING_REF } from '../tokens';

@Injectable()
export class DurableObjectService {
  constructor(@Inject(DO_BINDING_REF) private ref: BindingRef<DurableObjectNamespace>) {}

  get namespace(): DurableObjectNamespace {
    return this.ref.value;
  }
}
