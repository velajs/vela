import { describe, expect, it } from 'vitest';
import { stepCountIs } from '../index';

import { defineAgent } from '../index';
import type { AgentGenerate } from '../index';
import { createAgentHarness, memoryThreadStore } from '../testing';
import { countingTool, resolveTestRunIdentity, testThreadScope, toolCall } from './support';

/** A generate seam that never stops — every turn asks for another tool call. */
const neverStops: AgentGenerate = async ({ turn }) => ({
  text: '',
  toolCalls: [toolCall('echo', `call-${String(turn)}`, { value: 'x' })],
});

describe('loop termination', () => {
  it('stops at the default maxTurns budget and marks the thread errored', async () => {
    const store = memoryThreadStore();
    const { tool } = countingTool();
    const agent = defineAgent({
      model: 'test-model',
      store,
      resolveRunIdentity: resolveTestRunIdentity,
      tools: { echo: tool },
    });
    const agentHarness = createAgentHarness();

    const result = await agentHarness.runAgent(agent, 'looper', {
      params: { threadKey: 't-max', input: 'go', runKey: 'run-max' },
      generate: neverStops,
    });

    expect(result.status).toBe('complete');
    expect(result.output?.stopped).toBe('maxTurns');
    expect(result.output?.turns).toBe(8);
    expect(store.getThread(testThreadScope('t-max', 'agent-looper'))?.status).toBe('error');
  });

  it('honours a custom maxTurns', async () => {
    const store = memoryThreadStore();
    const { tool } = countingTool();
    const agent = defineAgent({
      model: 'test-model',
      store,
      resolveRunIdentity: resolveTestRunIdentity,
      tools: { echo: tool },
      maxTurns: 3,
    });
    const agentHarness = createAgentHarness();

    const result = await agentHarness.runAgent(agent, 'looper', {
      params: { threadKey: 't-max3', input: 'go', runKey: 'run-max3' },
      generate: neverStops,
    });

    expect(result.output?.stopped).toBe('maxTurns');
    expect(result.output?.turns).toBe(3);
  });

  it('ends on a stopWhen condition before maxTurns, leaving the thread idle', async () => {
    const store = memoryThreadStore();
    const { tool } = countingTool();
    const agent = defineAgent({
      model: 'test-model',
      store,
      resolveRunIdentity: resolveTestRunIdentity,
      tools: { echo: tool },
      stopWhen: stepCountIs(2),
      maxTurns: 8,
    });
    const agentHarness = createAgentHarness();

    const result = await agentHarness.runAgent(agent, 'looper', {
      params: { threadKey: 't-stop', input: 'go', runKey: 'run-stop' },
      generate: neverStops,
    });

    expect(result.status).toBe('complete');
    expect(result.output?.stopped).toBe('stopCondition');
    expect(result.output?.turns).toBe(2);
    expect(store.getThread(testThreadScope('t-stop', 'agent-looper'))?.status).toBe('idle');
  });
});
