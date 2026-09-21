import { describe, expect, it } from 'vitest';

import { AGENT_APPROVAL_EVENT_TYPE, defineAgent } from '../index';
import type { AgentGenerate } from '../index';
import {
  createAgentHarness,
  finalTurn,
  memoryRag,
  memoryThreadStore,
  scriptedGenerate,
  toolCallTurn,
} from '../testing';
import {
  approvalPayload,
  countingTool,
  eventCollector,
  resolveTestRunIdentity,
  toolCall,
} from './support';

describe('inject-mode memory', () => {
  it('runs one memory:retrieve step, memoized across a replay, and injects context on every turn', async () => {
    const store = memoryThreadStore();
    const rag = memoryRag({ context: 'REMEMBERED CONTEXT' });
    const { tool } = countingTool({ needsApproval: true });
    const collector = eventCollector();

    // Record the system-message content the generate seam sees on each call.
    const systemsPerCall: string[][] = [];
    const generate: AgentGenerate = async ({ turn, messages }) => {
      systemsPerCall.push(
        messages
          .filter((message) => message.role === 'system' && typeof message.content === 'string')
          .map((message) => message.content as string),
      );

      return turn === 0
        ? toolCallTurn([toolCall('echo', 'call-0', { value: 'x' })])
        : finalTurn('done');
    };

    const agent = defineAgent({
      model: 'test-model',
      store,
      resolveRunIdentity: resolveTestRunIdentity,
      tools: { echo: tool },
      verifyApproval: () => true,
      onThreadEvent: collector.sink,
      memory: { rag },
    });
    const agentHarness = createAgentHarness();
    const runParams = { threadKey: 't-mem', input: 'question', runKey: 'run-mem' };

    const parked = await agentHarness.runAgent(agent, 'mem', { params: runParams, generate });
    expect(parked.status).toBe('suspended');
    expect(agentHarness.harness.invocations('memory:retrieve')).toBe(1);

    const done = await agentHarness.runAgent(agent, 'mem', {
      params: runParams,
      generate,
      deliver: {
        'approval:0:echo:call-0': {
          type: AGENT_APPROVAL_EVENT_TYPE,
          payload: approvalPayload(collector, 'approve'),
        },
      },
    });
    expect(done.status).toBe('complete');
    // Memoized across the resume replay — still exactly one retrieval.
    expect(agentHarness.harness.invocations('memory:retrieve')).toBe(1);

    // Retrieved context is never elevated to a system instruction.
    expect(systemsPerCall.length).toBeGreaterThanOrEqual(2);
    expect(systemsPerCall.every((systems) => !systems.includes('REMEMBERED CONTEXT'))).toBe(true);
  });

  it('names a keyed source memory:retrieve:<key>', async () => {
    const store = memoryThreadStore();
    const rag = memoryRag({ context: 'CTX' });
    const agent = defineAgent({
      model: 'test-model',
      store,
      resolveRunIdentity: resolveTestRunIdentity,
      memory: { rag, key: 'docs' },
    });
    const agentHarness = createAgentHarness();

    const result = await agentHarness.runAgent(agent, 'mem', {
      params: { threadKey: 't-keyed', input: 'q', runKey: 'run-keyed' },
      generate: scriptedGenerate([finalTurn('done')]),
    });

    expect(result.status).toBe('complete');
    expect(agentHarness.harness.invocations('memory:retrieve:docs')).toBe(1);
    expect(agentHarness.harness.invocations('memory:retrieve')).toBe(0);
  });

  it('forwards topK/namespace/auth to rag.retrieve', async () => {
    const rag = memoryRag({ context: 'CTX' });
    const agent = defineAgent({
      model: 'test-model',
      store: memoryThreadStore(),
      resolveRunIdentity: resolveTestRunIdentity,
      memory: { rag, topK: 3, namespace: 'tenant-1', auth: { userId: 'u1' } },
    });
    const agentHarness = createAgentHarness();

    await agentHarness.runAgent(agent, 'mem', {
      params: { threadKey: 't-fwd', input: 'q', runKey: 'run-fwd' },
      generate: scriptedGenerate([finalTurn('done')]),
    });

    const calls = rag.queries();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toBe('q');
    expect(calls[0]?.options?.topK).toBe(3);
    expect(calls[0]?.options?.namespace).toBe('tenant-1');
    expect(calls[0]?.options?.auth).toEqual({ userId: 'u1' });
  });
});
