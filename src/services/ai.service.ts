import { Injectable, Inject } from '@velajs/vela';
import type { BindingRef } from '../binding-ref';
import { AI_BINDING_REF } from '../tokens';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AIBinding = { run: Function } & Record<string, any>;

/**
 * Wrapper around Cloudflare Workers AI binding.
 * Injected via `AIModule.forRoot({ binding: 'AI' })`.
 */
@Injectable()
export class AIService {
  constructor(@Inject(AI_BINDING_REF) private ref: BindingRef) {}

  /** Access the raw Ai binding directly. */
  get binding(): AIBinding {
    return this.ref.value as AIBinding;
  }

  run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> {
    return this.binding.run(model, inputs, options);
  }
}
