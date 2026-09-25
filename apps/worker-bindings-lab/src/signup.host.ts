import { InjectEnv, Injectable, type VelaEnv } from '@velajs/vela';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

/** What each Signup Workflow instance is created with. */
export interface SignupParams {
  readonly email: string;
}

/**
 * The Signup Workflow's body. Each run executes in the Worker's application,
 * so the host injects ENV like any provider; the engine's `step` passes
 * through untouched, so `step.do` keeps its retries and stored results.
 */
@Injectable()
export class SignupHost {
  constructor(@InjectEnv() private readonly env: VelaEnv) {}

  async run(event: WorkflowEvent<SignupParams>, step: WorkflowStep): Promise<{ welcomed: string }> {
    const welcomed = await step.do('welcome', async () => {
      this.env.EVENT_LOG.push(`signup:${event.payload.email}`);
      return event.payload.email;
    });
    return { welcomed };
  }
}
