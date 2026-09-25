import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import { defineStep, defineWorkflow, WorkflowNonRetryableError } from '../../index';
import { runCloudflareWorkflow } from '../../cloudflare/index';

declare global {
  namespace Cloudflare {
    interface Env {
      BRIDGE: Workflow;
      LABEL: string;
    }
  }
}

const schema = z.object({
  mode: z.enum(['resume', 'fatal', 'runStep', 'rollback']),
  count: z.string().transform(Number),
});
const fatalStep = defineStep({
  name: 'fatal-reusable',
  args: {},
  handler: () => {
    throw new WorkflowNonRetryableError('terminal reusable');
  },
});
const definition = defineWorkflow<z.output<typeof schema>>({
  async handler(ctx) {
    if (ctx.params.mode === 'fatal') {
      return ctx.step.do('fatal-raw', { retries: { limit: 4, delay: 1 } }, async () => {
        throw new WorkflowNonRetryableError('terminal raw', 'PolicyDenied');
      });
    }
    if (ctx.params.mode === 'runStep') return ctx.runStep(fatalStep, {});
    if (ctx.params.mode === 'rollback') {
      await ctx.step.do('forward', async () => 'saved', {
        rollback: async () => {
          throw new WorkflowNonRetryableError('terminal rollback');
        },
        rollbackConfig: { retries: { limit: 4, delay: 1 } },
      });
      throw new WorkflowNonRetryableError('trigger rollback');
    }
    const first = await ctx.step.do(
      'first',
      { retries: { limit: 1, delay: 1 } },
      async ({ attempt }) => {
        if (attempt === 1) throw new Error('temporary');
        return {
          attempt,
          label: ctx.env.LABEL,
          count: ctx.params.count,
          random: crypto.randomUUID(),
        };
      },
    );
    const event = await ctx.step.waitForEvent('approval', { type: 'approved' });
    const payload = z.object({ accepted: z.boolean() }).parse(event.payload);
    const dispatched = await ctx.step.do('dispatch', () => ctx.run({ path: '/verified' }));
    return { first, accepted: payload.accepted, dispatched };
  },
});

export class BridgeWorkflow extends WorkflowEntrypoint<Cloudflare.Env> {
  override run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    return runCloudflareWorkflow(definition, {
      schema,
      event,
      step,
      env: { ...this.env },
      // Test seam: the caller supplies dispatch from this invocation's env.
      run: async () => this.env.LABEL,
    });
  }
}
export default { fetch: () => new Response('ok') };
