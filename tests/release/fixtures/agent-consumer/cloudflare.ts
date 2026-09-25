import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { defineAgent, compileAgent, type AgentThreadStore } from '@velajs/agent';
import {
  AgentThreadDurableObject,
  agentRunParamsSchema,
  durableAgentThreadStore,
} from '@velajs/agent/cloudflare';
import { runCloudflareWorkflow } from '@velajs/workflow/cloudflare';

export class Threads extends AgentThreadDurableObject {}
type Env = { THREADS: DurableObjectNamespace<Threads> };
export class Review extends WorkflowEntrypoint<Env> {
  override run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const store: AgentThreadStore = durableAgentThreadStore(this.env.THREADS);
    const definition = compileAgent(
      defineAgent({
        model: 'example/scripted',
        store,
        resolveRunIdentity: () => ({ ownerId: 'operator', tenantId: 'workspace' }),
      }),
      'review',
      { generate: async () => ({ text: 'ok', toolCalls: [] }) },
    );
    return runCloudflareWorkflow(definition, {
      schema: agentRunParamsSchema,
      event,
      step,
      env: { ...this.env },
      run: async () => {
        throw new Error('No dispatch routes');
      },
    });
  }
}
export default { fetch: () => new Response('ok') };
