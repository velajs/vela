import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import { defineWorkflow } from '@velajs/workflow';
import { runCloudflareWorkflow, workflowEventStream } from '@velajs/workflow/cloudflare';

const schema = z.object({ count: z.number() });
const definition = defineWorkflow<z.output<typeof schema>, number>({
  handler: (ctx) => ctx.step.do('count', async () => ctx.params.count + 1),
});
export class Counter extends WorkflowEntrypoint<Record<string, unknown>> {
  override run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    return runCloudflareWorkflow(definition, {
      schema,
      event,
      step,
      env: this.env,
      run: async () => {
        throw new Error('No dispatch routes');
      },
    });
  }
}
export const progress = (instance: WorkflowInstance, authorize: (id: string) => Promise<void>) =>
  workflowEventStream({ instance, authorize });
export default { fetch: () => new Response('ok') };
