import { describe, expect, it, vi } from 'vitest';

import { AGENT_APPROVAL_EVENT_TYPE, defineAgent } from '../index';
import {
  createAgentHarness,
  finalTurn,
  memoryThreadStore,
  scriptedGenerate,
  toolCallTurn,
} from '../testing';
import {
  approvalPayload,
  countingTool,
  eventCollector,
  resolveTestRunIdentity,
  testThreadScope,
  toolCall,
} from './support';

const params = (threadKey: string, runKey: string) => ({ threadKey, input: 'do it', runKey });

describe('HITL approvals', () => {
  it('parks on waitForEvent and resumes on approve, executing exactly once', async () => {
    const store = memoryThreadStore();
    const { tool, count } = countingTool({ needsApproval: true });
    const collector = eventCollector();
    const agent = defineAgent({
      model: 'test-model',
      store,
      resolveRunIdentity: resolveTestRunIdentity,
      tools: { echo: tool },
      verifyApproval: () => true,
      onThreadEvent: collector.sink,
    });
    const generate = scriptedGenerate([
      toolCallTurn([toolCall('echo', 'call-0', { value: 'go' })]),
      finalTurn('done'),
    ]);
    const agentHarness = createAgentHarness();

    // Park: no event delivered.
    const parked = await agentHarness.runAgent(agent, 'approver', {
      params: params('t-approve', 'run-approve'),
      generate,
    });

    expect(parked.status).toBe('suspended');
    expect(parked.suspendedAt).toBe('approval:0:echo:call-0');
    expect(count()).toBe(0);

    const scope = testThreadScope('t-approve', 'agent-approver');
    const rows = await store.listMessages(scope);
    expect(rows.some((row) => row.status === 'awaiting_approval')).toBe(true);
    expect(store.getThread(scope)?.status).toBe('awaiting_input');
    expect(collector.ofType('approval-requested')).toHaveLength(1);

    const turnInvocationsAtPark = agentHarness.harness.invocations('llm:turn:0');
    expect(turnInvocationsAtPark).toBe(1);

    // Resume: deliver an approve event on the wait name.
    const done = await agentHarness.runAgent(agent, 'approver', {
      params: params('t-approve', 'run-approve'),
      generate,
      deliver: {
        'approval:0:echo:call-0': {
          type: AGENT_APPROVAL_EVENT_TYPE,
          payload: approvalPayload(collector, 'approve'),
        },
      },
    });

    expect(done.status).toBe('complete');
    expect(done.output?.stopped).toBe('final');
    expect(done.output?.text).toBe('done');
    expect(count()).toBe(1);
    // The turn before the wait stayed memoized across suspend/resume.
    expect(agentHarness.harness.invocations('llm:turn:0')).toBe(turnInvocationsAtPark);
    expect(collector.ofType('approval-resolved')).toHaveLength(1);
    expect(collector.ofType('approval-resolved')[0]?.decision).toBe('approve');
  });

  it('resumes on reject without executing, and the next turn recovers', async () => {
    const store = memoryThreadStore();
    const { tool, count } = countingTool({ needsApproval: true });
    const collector = eventCollector();
    const agent = defineAgent({
      model: 'test-model',
      store,
      resolveRunIdentity: resolveTestRunIdentity,
      tools: { echo: tool },
      verifyApproval: () => true,
      onThreadEvent: collector.sink,
    });
    const generate = scriptedGenerate([
      toolCallTurn([toolCall('echo', 'call-0', { value: 'go' })]),
      finalTurn('recovered'),
    ]);
    const agentHarness = createAgentHarness();

    await agentHarness.runAgent(agent, 'approver', {
      params: params('t-reject', 'run-reject'),
      generate,
    });

    const done = await agentHarness.runAgent(agent, 'approver', {
      params: params('t-reject', 'run-reject'),
      generate,
      deliver: {
        'approval:0:echo:call-0': {
          type: AGENT_APPROVAL_EVENT_TYPE,
          payload: approvalPayload(collector, 'reject', 'not allowed'),
        },
      },
    });

    expect(done.status).toBe('complete');
    expect(done.output?.text).toBe('recovered');
    expect(count()).toBe(0);

    const rows = await store.listMessages(testThreadScope('t-reject', 'agent-approver'));
    const rejection = rows.find((row) => row.role === 'tool' && row.status === 'rejected');
    expect(rejection).toBeDefined();
    expect(rejection?.content).toContain('rejected');
    expect(rejection?.content).toContain('not allowed');
  });

  it('memoizes needsApproval so replay cannot bypass a parked gate', async () => {
    const store = memoryThreadStore();
    let predicateCalls = 0;
    let externalMutation = 0;
    const { tool, count } = countingTool({
      needsApproval: (): boolean => {
        predicateCalls += 1;
        externalMutation += 1;

        return true;
      },
    });
    const collector = eventCollector();
    const agent = defineAgent({
      model: 'test-model',
      store,
      resolveRunIdentity: resolveTestRunIdentity,
      tools: { echo: tool },
      verifyApproval: () => true,
      onThreadEvent: collector.sink,
    });
    const generate = scriptedGenerate([
      toolCallTurn([toolCall('echo', 'call-0', { value: 'go' })]),
      finalTurn('done'),
    ]);
    const agentHarness = createAgentHarness();

    await agentHarness.runAgent(agent, 'approver', {
      params: params('t-pure', 'run-pure'),
      generate,
    });
    const callsAtPark = predicateCalls;
    expect(callsAtPark).toBeGreaterThanOrEqual(1);

    const done = await agentHarness.runAgent(agent, 'approver', {
      params: params('t-pure', 'run-pure'),
      generate,
      deliver: {
        'approval:0:echo:call-0': {
          type: AGENT_APPROVAL_EVENT_TYPE,
          payload: approvalPayload(collector, 'approve'),
        },
      },
    });

    expect(done.status).toBe('complete');
    expect(predicateCalls).toBe(callsAtPark);
    expect(externalMutation).toBe(predicateCalls);
    expect(count()).toBe(1);
    expect(agentHarness.harness.invocations('approval-gate:0:echo:call-0')).toBe(1);
    expect(agentHarness.harness.invocations('approval-verify:0:echo:call-0')).toBe(1);
  });

  it('atomically rejects reuse of a consumed nonce across independently bound approvals', async () => {
    const fixedNonce = '00000000-0000-4000-8000-000000000001';
    const randomUuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue(fixedNonce);
    const consumed = new Set<string>();
    let verificationCalls = 0;
    const { tool, count } = countingTool({ needsApproval: true });
    const collector = eventCollector();
    const store = memoryThreadStore();
    const agent = defineAgent({
      model: 'test-model',
      store,
      resolveRunIdentity: resolveTestRunIdentity,
      tools: { echo: tool },
      onThreadEvent: collector.sink,
      verifyApproval: (event) => {
        verificationCalls += 1;
        if (event.approverId !== 'test-approver' || consumed.has(event.nonce)) return false;
        consumed.add(event.nonce);
        return true;
      },
    });
    const generate = scriptedGenerate([
      toolCallTurn([toolCall('echo', 'call-0', { value: 'go' })]),
      finalTurn('done'),
    ]);

    try {
      const firstHarness = createAgentHarness();
      await firstHarness.runAgent(agent, 'nonceReplay', {
        params: params('t-nonce-a', 'run-nonce-a'),
        generate,
      });
      const first = await firstHarness.runAgent(agent, 'nonceReplay', {
        params: params('t-nonce-a', 'run-nonce-a'),
        generate,
        deliver: {
          'approval:0:echo:call-0': {
            type: AGENT_APPROVAL_EVENT_TYPE,
            payload: approvalPayload(collector, 'approve'),
          },
        },
      });
      expect(first.status).toBe('complete');
      expect(count()).toBe(1);

      const secondHarness = createAgentHarness();
      await secondHarness.runAgent(agent, 'nonceReplay', {
        params: params('t-nonce-b', 'run-nonce-b'),
        generate,
      });
      const second = await secondHarness.runAgent(agent, 'nonceReplay', {
        params: params('t-nonce-b', 'run-nonce-b'),
        generate,
        deliver: {
          'approval:0:echo:call-0': {
            type: AGENT_APPROVAL_EVENT_TYPE,
            payload: approvalPayload(collector, 'approve'),
          },
        },
      });

      expect(second.status).toBe('complete');
      expect(verificationCalls).toBe(2);
      expect(consumed).toEqual(new Set([fixedNonce]));
      expect(count()).toBe(1);
      const rows = await store.listMessages(testThreadScope('t-nonce-b', 'agent-nonce-replay'));
      expect(rows.find((row) => row.status === 'rejected')?.content).toContain('unauthorized');
    } finally {
      randomUuid.mockRestore();
    }
  });

  it('fails closed for malformed, unbound, or unverifiable approvals', async () => {
    const store = memoryThreadStore();
    const { tool, count } = countingTool({ needsApproval: true });
    const collector = eventCollector();
    const agent = defineAgent({
      model: 'test-model',
      store,
      resolveRunIdentity: resolveTestRunIdentity,
      tools: { echo: tool },
      onThreadEvent: collector.sink,
    });
    const generate = scriptedGenerate([
      toolCallTurn([toolCall('echo', 'call-0', { value: 'go' })]),
      finalTurn('recovered'),
    ]);
    const agentHarness = createAgentHarness();

    await agentHarness.runAgent(agent, 'approver', {
      params: params('t-invalid', 'run-invalid'),
      generate,
    });
    const forged = { ...approvalPayload(collector, 'approve'), toolCallId: 'another-call' };
    const done = await agentHarness.runAgent(agent, 'approver', {
      params: params('t-invalid', 'run-invalid'),
      generate,
      deliver: {
        'approval:0:echo:call-0': { type: AGENT_APPROVAL_EVENT_TYPE, payload: forged },
      },
    });

    expect(done.status).toBe('complete');
    expect(count()).toBe(0);
    const rows = await store.listMessages(testThreadScope('t-invalid', 'agent-approver'));
    expect(rows.find((row) => row.status === 'rejected')?.content).toContain('unauthorized');
  });

  it('rejects duplicate model tool-call ids before executing either call', async () => {
    const first = countingTool();
    const second = countingTool();
    const agent = defineAgent({
      model: 'test-model',
      store: memoryThreadStore(),
      resolveRunIdentity: resolveTestRunIdentity,
      tools: { first: first.tool, second: second.tool },
    });
    const agentHarness = createAgentHarness();

    await expect(
      agentHarness.runAgent(agent, 'duplicateIds', {
        params: params('t-duplicate-ids', 'run-duplicate-ids'),
        generate: scriptedGenerate([
          toolCallTurn([
            toolCall('first', 'same-id', { value: 'one' }),
            toolCall('second', 'same-id', { value: 'two' }),
          ]),
        ]),
      }),
    ).rejects.toThrow(/unique for the entire run/);
    expect(first.count()).toBe(0);
    expect(second.count()).toBe(0);
  });

  it('binds approval to turn, tool name, and canonical input digest', async () => {
    const collector = eventCollector();
    const agent = defineAgent({
      model: 'test-model',
      store: memoryThreadStore(),
      resolveRunIdentity: resolveTestRunIdentity,
      tools: { echo: countingTool({ needsApproval: true }).tool },
      verifyApproval: () => true,
      onThreadEvent: collector.sink,
    });
    const agentHarness = createAgentHarness();
    await agentHarness.runAgent(agent, 'boundApproval', {
      params: params('t-bound', 'run-bound'),
      generate: scriptedGenerate([
        toolCallTurn([toolCall('echo', 'call-bound', { value: 'one' })]),
      ]),
    });

    const approval = collector.ofType('approval-requested')[0]?.approval;
    expect(approval).toMatchObject({
      turn: 0,
      toolName: 'echo',
      ownerId: 'test-owner',
      tenantId: 'test-tenant',
    });
    expect(approval?.inputDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('requires a trusted identity resolver at declaration time', () => {
    const config = { model: 'test-model', store: memoryThreadStore() } as unknown as Parameters<
      typeof defineAgent
    >[0];

    expect(() => defineAgent(config)).toThrow(/resolveRunIdentity/);
  });

  it.each([
    { ownerId: '', tenantId: 'tenant-a' },
    { ownerId: 'user-a', tenantId: '   ' },
    { ownerId: ' user-a', tenantId: 'tenant-a' },
  ])('rejects an invalid trusted run identity before thread allocation: %j', async (identity) => {
    const store = memoryThreadStore();
    const agent = defineAgent({
      model: 'test-model',
      store,
      resolveRunIdentity: () => identity,
    });
    const agentHarness = createAgentHarness();

    await expect(
      agentHarness.runAgent(agent, 'scoped', {
        params: params('t-scoped', 'run-scoped'),
        generate: scriptedGenerate([finalTurn('no')]),
      }),
    ).rejects.toThrow(/invalid identity/);
    expect(store.getThread(testThreadScope('t-scoped', 'agent-scoped'))).toBeUndefined();
  });
});
