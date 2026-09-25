import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { runCloudflareWorkflow } from '@velajs/workflow/cloudflare';
import { z } from 'zod';
import { compileAgent, defineAgent, functionTool } from '../../index';
import {
  AgentThreadDurableObject,
  agentRunParamsSchema,
  durableAgentThreadStore,
} from '../../cloudflare/index';

declare global {
  namespace Cloudflare {
    interface Env {
      THREADS: DurableObjectNamespace<Threads>;
      OTHER_THREADS: DurableObjectNamespace<OtherThreads>;
      AGENT: Workflow;
    }
  }
}
export class Threads extends AgentThreadDurableObject {}
export class OtherThreads extends AgentThreadDurableObject {}
export const identity = { ownerId: 'operator', tenantId: 'tenant-a' };

export class AgentWorkflow extends WorkflowEntrypoint<Cloudflare.Env> {
  override run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const store = durableAgentThreadStore(this.env.THREADS);
    const agent = defineAgent({
      name: 'reviewer',
      model: 'example/scripted',
      store,
      // Test-only trusted identity, independent of trigger selectors.
      resolveRunIdentity: () => identity,
      verifyApproval: (approval) =>
        store.verifyApproval(
          {
            ...identity,
            agent: 'reviewer',
            threadKey: approval.threadKey,
          },
          approval,
        ),
      tools: {
        acknowledge: functionTool({
          description: 'Record approval',
          inputSchema: z.object({ message: z.string() }),
          needsApproval: true,
          execute: ({ message }, context) =>
            context.run({ path: '/acknowledge' }, { body: message }),
        }),
      },
    });
    const compiled = compileAgent(agent, 'reviewer', {
      generate: async ({ turn }) =>
        turn === 0
          ? {
              text: '',
              toolCalls: [{ id: 'call-1', name: 'acknowledge', input: { message: 'approved' } }],
            }
          : { text: 'done', toolCalls: [] },
    });
    return runCloudflareWorkflow(compiled, {
      schema: agentRunParamsSchema,
      event,
      step,
      env: { ...this.env },
      run: async (_target, init) => ({ acknowledged: init?.body }),
    });
  }
}
export default { fetch: () => new Response('ok') };
