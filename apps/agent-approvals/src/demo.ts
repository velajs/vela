import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  AGENT_APPROVAL_EVENT_TYPE,
  approvalWaitName,
  defineAgent,
  functionTool,
} from '@velajs/agent';
import {
  createAgentHarness,
  finalTurn,
  memoryThreadStore,
  scriptedGenerate,
  toolCallTurn,
} from '@velajs/agent/testing';

// Test-only identities and approval ledger: production uses authenticated trigger
// metadata and a transactional, authenticated approval service.
const identity = { ownerId: 'operator', tenantId: 'shop' };
const approvedNonces = new Set<string>();
const effects = new Map<string, string>();
const store = memoryThreadStore();
const agent = defineAgent({
  model: 'example/scripted',
  store,
  resolveRunIdentity: () => identity,
  verifyApproval: (event) => event.approverId === 'manager' && approvedNonces.has(event.nonce),
  tools: {
    refund: functionTool({
      description: 'Refund an order after a manager approves.',
      inputSchema: z.object({ orderId: z.string() }),
      needsApproval: true,
      execute: ({ orderId }, { idempotencyKey }) => {
        // Real payment services must atomically accept an idempotency key too.
        if (!effects.has(idempotencyKey)) effects.set(idempotencyKey, `Refunded ${orderId}`);
        return effects.get(idempotencyKey)!;
      },
    }),
  },
});
const generate = scriptedGenerate([
  toolCallTurn([{ name: 'refund', id: 'refund-1', input: { orderId: 'order-42' } }]),
  finalTurn('Your refund has been approved.'),
]);
const params = { threadKey: 'support-42', runKey: 'request-42', input: 'Refund order-42' };
const harness = createAgentHarness();
const parked = await harness.runAgent(agent, 'support', { params, generate });
assert.equal(parked.status, 'suspended');
assert.equal(effects.size, 0);

// Recover the challenge from storage; delivery of a live UI event is optional.
const rows = await store.listMessages({
  threadKey: params.threadKey,
  agent: 'agent-support',
  ...identity,
});
const challenge = rows.find((row) => row.status === 'awaiting_approval')?.approval;
assert.ok(challenge);
approvedNonces.add(challenge.nonce);
const done = await harness.runAgent(agent, 'support', {
  params,
  generate,
  deliver: {
    [approvalWaitName(0, 'refund', 'refund-1')]: {
      type: AGENT_APPROVAL_EVENT_TYPE,
      payload: { ...challenge, decision: 'approve', approverId: 'manager' },
    },
  },
});
assert.equal(done.status, 'complete');
assert.equal(effects.size, 1);

const duplicate = await createAgentHarness().runAgent(agent, 'support', { params, generate });
assert.deepEqual(duplicate.output, done.output);
assert.equal(effects.size, 1);
console.log('PASS: parked approval, persisted challenge, resumed tool, and duplicate delivery.');
