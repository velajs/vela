// @ts-expect-error virtual module supplied by @cloudflare/vitest-plugin
import * as test from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { AGENT_APPROVAL_EVENT_TYPE, type AgentApprovalEvent } from '../../index';
import { durableAgentThreadStore } from '../../cloudflare/index';
import { identity } from './entry';

interface Introspector {
  waitForStatus(status: string): Promise<void>;
  getOutput(): Promise<unknown>;
  dispose(): Promise<void>;
}
const pool: { introspectWorkflowInstance(binding: Workflow, id: string): Promise<Introspector> } =
  test;

it('compiles an agent into native approval wait/resume with durable duplicate delivery', async () => {
  const id = crypto.randomUUID();
  const params = { threadKey: id, runKey: 'logical-run', input: 'acknowledge' };
  const store = durableAgentThreadStore(env.THREADS);
  const scope = { ...identity, agent: 'reviewer', threadKey: id };
  const inspector = await pool.introspectWorkflowInstance(env.AGENT, id);
  try {
    const instance = await env.AGENT.create({ id, params });
    using subscription = await instance.subscribe({ filter: ['wait_started'] });
    expect((await subscription.next()).value).toMatchObject({
      type: 'wait_started',
      eventType: AGENT_APPROVAL_EVENT_TYPE,
    });
    const rows = await store.listMessages(scope);
    const challenge = rows.find((row) => row.approval)?.approval;
    expect(challenge).toBeDefined();
    if (!challenge) throw new Error('Missing persisted challenge');
    const event: AgentApprovalEvent = { ...challenge, decision: 'approve', approverId: 'manager' };
    await store.recordApproval(scope, event);
    await instance.sendEvent({ type: AGENT_APPROVAL_EVENT_TYPE, payload: event });
    await inspector.waitForStatus('complete');
    expect(await inspector.getOutput()).toMatchObject({ stopped: 'final', text: 'done', turns: 2 });
    const completed = await store.listMessages(scope);
    expect(completed.find((row) => row.status === 'approved')?.content).toBe(
      '{"acknowledged":"approved"}',
    );
    const duplicateId = crypto.randomUUID();
    const duplicate = await pool.introspectWorkflowInstance(env.AGENT, duplicateId);
    try {
      await env.AGENT.create({ id: duplicateId, params });
      await duplicate.waitForStatus('complete');
      expect(await duplicate.getOutput()).toEqual(await inspector.getOutput());
      expect(await store.listMessages(scope)).toEqual(completed);
    } finally {
      await duplicate.dispose();
    }
  } finally {
    await inspector.dispose();
  }
}, 15_000);
