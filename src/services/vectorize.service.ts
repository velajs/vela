import { Injectable, Inject } from '@velajs/vela';
import type { BindingRef } from '../binding-ref';
import { VECTORIZE_BINDING_REF } from '../tokens';

@Injectable()
export class VectorizeService {
  constructor(@Inject(VECTORIZE_BINDING_REF) private ref: BindingRef<VectorizeIndex>) {}

  get index(): VectorizeIndex {
    return this.ref.value;
  }
}
