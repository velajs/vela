import { Injectable, Inject } from '@velajs/vela';
import type { BindingRef } from '../binding-ref';
import { AI_BINDING_REF } from '../tokens';

@Injectable()
export class AIService {
  constructor(@Inject(AI_BINDING_REF) private ref: BindingRef<Ai>) {}

  get binding(): Ai {
    return this.ref.value;
  }
}
