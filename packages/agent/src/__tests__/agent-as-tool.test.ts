import { describe, expect, it } from 'vitest';
import type {
  WorkflowBindingLike,
  WorkflowCreateOptions,
  WorkflowInstanceLike,
  WorkflowStatusResult,
} from '@velajs/workflow';

import { defineAgent } from '../index';
import type { AgentRunParams } from '../index';
import {
  createAgentHarness,
  finalTurn,
  memoryThreadStore,
  scriptedGenerate,
  toolCallTurn,
} from '../testing';
import { resolveTestRunIdentity, testThreadScope, toolCall } from './support';

/** A workflow instance double that reports `running` once, then `complete`. */
const makeInstance = (): { instance: WorkflowInstanceLike; statusCalls: () => number } => {
  let calls = 0;
  const instance: WorkflowInstanceLike = {
    id: 'child-instance',
    status: async (): Promise<WorkflowStatusResult> => {
      calls += 1;

      return calls < 2
        ? { status: 'running' }
        : { status: 'complete', output: { stopped: 'final', text: 'child answer', turns: 1 } };
    },
    pause: async () => undefined,
    resume: async () => undefined,
    restart: async () => undefined,
    terminate: async () => undefined,
    sendEvent: async () => undefined,
  };

  return { instance, statusCalls: () => calls };
};

describe('agentAsTool', () => {
  it('starts a child instance with deterministic ids and returns its final answer', async () => {
    const { instance, statusCalls } = makeInstance();
    const created: Array<WorkflowCreateOptions<AgentRunParams>> = [];

    const binding: WorkflowBindingLike<AgentRunParams> = {
      create: async (options) => {
        if (options !== undefined) {
          created.push(options);
        }

        return instance;
      },
      createBatch: async () => [instance],
      get: async () => instance,
    };

    const child = defineAgent({
      model: 'test-model',
      store: memoryThreadStore(),
      resolveRunIdentity: resolveTestRunIdentity,
    });
    const parentStore = memoryThreadStore();
    const parent = defineAgent({
      model: 'test-model',
      store: parentStore,
      resolveRunIdentity: resolveTestRunIdentity,
      tools: {
        research: child.asTool({
          name: 'support',
          description: 'Delegate to the support agent',
          pollIntervalMs: 0,
        }),
      },
    });

    const agentHarness = createAgentHarness();
    const result = await agentHarness.runAgent(parent, 'main', {
      params: { threadKey: 't-parent', input: 'hi', runKey: 'run-parent' },
      env: { AGENT_SUPPORT: binding },
      generate: scriptedGenerate([
        toolCallTurn([toolCall('research', 'call-0', { prompt: 'please help' })]),
        finalTurn('parent done'),
      ]),
    });

    expect(result.status).toBe('complete');

    // The child was created once, under replay-stable ids derived from the parent.
    expect(created).toHaveLength(1);
    expect(created[0]?.id).toMatch(/^sub-[a-f0-9]{64}$/);
    expect(created[0]?.params?.threadKey).toBe(created[0]?.id);
    expect(created[0]?.params?.runKey).toBe(created[0]?.id);
    expect(created[0]?.params?.input).toBe('please help');
    expect(created[0]?.params?.owner).toBe('test-owner');
    expect(created[0]?.params?.tenantId).toBe('test-tenant');

    // It polled until terminal, ran inside the parent tool step, and returned the answer.
    expect(statusCalls()).toBeGreaterThanOrEqual(2);
    expect(agentHarness.harness.invocations('tool:research:call-0')).toBe(1);

    const rows = await parentStore.listMessages(testThreadScope('t-parent', 'agent-main'));
    const toolResult = rows.find((row) => row.role === 'tool' && row.toolCallId === 'call-0');
    expect(toolResult?.content).toBe('child answer');
  });

  it('throws when the child agent binding is missing from env', async () => {
    const child = defineAgent({
      model: 'test-model',
      store: memoryThreadStore(),
      resolveRunIdentity: resolveTestRunIdentity,
    });
    const parent = defineAgent({
      model: 'test-model',
      store: memoryThreadStore(),
      resolveRunIdentity: resolveTestRunIdentity,
      tools: {
        research: child.asTool({ name: 'support', description: 'Delegate', pollIntervalMs: 0 }),
      },
    });

    const agentHarness = createAgentHarness();

    await expect(
      agentHarness.runAgent(parent, 'main', {
        params: { threadKey: 't-nobind', input: 'hi', runKey: 'run-nobind' },
        env: {},
        generate: scriptedGenerate([
          toolCallTurn([toolCall('research', 'call-0', { prompt: 'help' })]),
          finalTurn('done'),
        ]),
      }),
    ).rejects.toThrow(/AGENT_SUPPORT/);
  });
});
