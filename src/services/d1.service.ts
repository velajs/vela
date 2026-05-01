import { Injectable, Inject } from '@velajs/vela';
import type { BindingRef } from '../binding-ref';
import { D1_BINDING_REF } from '../tokens';

@Injectable()
export class D1Service {
  constructor(@Inject(D1_BINDING_REF) private ref: BindingRef<D1Database>) {}

  get database(): D1Database {
    return this.ref.value;
  }
}
