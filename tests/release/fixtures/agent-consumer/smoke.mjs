import assert from 'node:assert/strict';
import { z } from 'zod';
import { MockLanguageModelV4 } from 'ai/test';
import { createAi } from '@velajs/ai';
import { defineRag, memoryVectors } from '@velajs/ai/rag';
import { parseInboundEmail } from '@velajs/mail';
import { isWorkflowDefinition } from '@velajs/workflow';
import {
  AGENT_APPROVAL_EVENT_TYPE,
  approvalWaitName,
  compileAgent,
  defineAgent,
  firstEmailRun,
  functionTool,
} from '@velajs/agent';
import { closeMcpTools, mcpTools } from '@velajs/agent/mcp';
import {
  createAgentHarness,
  finalTurn,
  memoryThreadStore,
  scriptedGenerate,
  toolCallTurn,
} from '@velajs/agent/testing';

const identity = { ownerId: 'owner', tenantId: 'tenant' };
const models = createAi({ defaultModel: new MockLanguageModelV4() });
const rag = defineRag({
  vectors: memoryVectors(),
  embed: () => [1],
  resolveNamespace: ({ auth, selector }) => {
    assert.equal(typeof auth?.tenantId, 'string');
    if (selector !== undefined) assert.equal(selector, auth.tenantId);
    return auth.tenantId;
  },
});
await rag.sync([{ id: 'policy', text: 'Refund policy: manager approval is required.' }], {
  auth: identity,
});
const store = memoryThreadStore();
let effects = 0;
const keys = [];
const agent = defineAgent({
  model: models.model(),
  store,
  resolveRunIdentity: () => identity,
  memory: { rag },
  verifyApproval: (event) => event.approverId === 'manager',
  onEmail: (email) =>
    email.authentication.dmarc === 'pass'
      ? { threadKey: 'mail-thread', runKey: 'mail-1', input: email.subject ?? '' }
      : null,
  tools: {
    refund: functionTool({
      description: 'Refund',
      inputSchema: z.object({ orderId: z.string() }),
      needsApproval: true,
      execute: (_input, ctx) => {
        effects++;
        keys.push(ctx.idempotencyKey);
        return 'refunded';
      },
    }),
  },
});
assert.equal(isWorkflowDefinition(compileAgent(agent, 'support')), true);
const raw =
  'From: user@example.com\r\nTo: support@example.com\r\nSubject: Refund order\r\n\r\nPlease help';
const email = parseInboundEmail(raw, {
  verifiedAuthentication: { dkim: 'pass', spf: 'pass', dmarc: 'pass' },
});
const params = await firstEmailRun([{ agent }], email);
assert.ok(params);
const script = scriptedGenerate([
  toolCallTurn([{ id: 'refund-1', name: 'refund', input: { orderId: '42' } }]),
  finalTurn('done'),
]);
const generate = async (options) => {
  assert.ok(
    options.messages.some(
      (message) => message.role === 'user' && String(message.content).includes('Refund policy'),
    ),
  );
  return script(options);
};
const harness = createAgentHarness();
assert.equal((await harness.runAgent(agent, 'support', { params, generate })).status, 'suspended');
assert.equal(effects, 0);
const rows = await store.listMessages({
  ...identity,
  agent: 'agent-support',
  threadKey: params.threadKey,
});
const challenge = rows.find((row) => row.approval)?.approval;
assert.ok(challenge);
const completed = await harness.runAgent(agent, 'support', {
  params,
  generate,
  deliver: {
    [approvalWaitName(0, 'refund', 'refund-1')]: {
      type: AGENT_APPROVAL_EVENT_TYPE,
      payload: { ...challenge, decision: 'approve', approverId: 'manager' },
    },
  },
});
assert.equal(completed.output.text, 'done');
assert.equal(effects, 1);
const duplicate = await createAgentHarness().runAgent(agent, 'support', { params, generate });
assert.deepEqual(duplicate.output, completed.output);
assert.equal(effects, 1);
assert.match(keys[0], /^agent-[a-f0-9]{64}$/);

let closed = 0;
const tools = await mcpTools({
  only: ['lookup'],
  readOnlyTools: ['lookup'],
  client: {
    listTools: async () => ({ tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] }),
    callTool: async () => ({ content: [{ type: 'text', text: 'found' }] }),
    close: async () => {
      closed++;
    },
  },
});
const mcpAgent = defineAgent({
  model: models.model(),
  store: memoryThreadStore(),
  resolveRunIdentity: () => identity,
  tools,
});
assert.equal(
  (
    await createAgentHarness().runAgent(mcpAgent, 'search', {
      params: { threadKey: 'search', input: 'lookup' },
      generate: scriptedGenerate([
        toolCallTurn([{ id: 'lookup-1', name: 'lookup', input: {} }]),
        finalTurn('found'),
      ]),
    })
  ).status,
  'complete',
);
await closeMcpTools(tools);
assert.equal(closed, 1);
