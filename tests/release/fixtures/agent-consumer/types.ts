import { compileAgent, defineAgent, functionTool, hasToolCall } from '@velajs/agent';
import type { AgentEmailMapper, RagLike } from '@velajs/agent';
import { mcpTools, closeMcpTools } from '@velajs/agent/mcp';
import { createAgentHarness, memoryThreadStore } from '@velajs/agent/testing';
import { createAi } from '@velajs/ai';
import type { Rag } from '@velajs/ai/rag';
import type { InboundEmail } from '@velajs/mail';
import type { WorkflowDefinition } from '@velajs/workflow';
import { z } from 'zod';

const compatible = (rag: Pick<Rag, 'retrieve'>): RagLike => rag;
const mapper: AgentEmailMapper = (email: InboundEmail) => ({
  threadKey: 'mail',
  input: email.subject ?? '',
});
const models = createAi({ defaultModel: 'provider/model' });
const agent = defineAgent({
  model: models.model(),
  store: memoryThreadStore(),
  resolveRunIdentity: () => ({ ownerId: 'owner', tenantId: 'tenant' }),
  onEmail: mapper,
  stopWhen: hasToolCall('echo'),
  tools: {
    echo: functionTool({
      description: 'Echo',
      inputSchema: z.object({ value: z.string() }),
      execute: ({ value }) => value,
    }),
  },
});
const workflow: WorkflowDefinition<{ threadKey: string; input: string }, unknown> = compileAgent(
  agent,
  'demo',
);
const route = functionTool(
  { path: '/lookup' },
  { description: 'Lookup', inputSchema: z.object({ id: z.string() }) },
);
type Context = Parameters<typeof route.execute>[1];
async function routeType(ctx: Context) {
  const result = await route.execute({ id: 'a' }, ctx);
  // @ts-expect-error a raw dispatch result must be validated before accessing domain fields
  result.id;
}
void [compatible, workflow, routeType, createAgentHarness, mcpTools, closeMcpTools];
