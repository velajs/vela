import { describe, expect, it } from 'vitest';

import { defineAgent } from '../index';
import type { AgentGenerate } from '../index';
import { createAgentHarness, memoryThreadStore } from '../testing';
import { countingTool, resolveTestRunIdentity, toolCall } from './support';

describe('invariant (a): completed steps are never re-executed on replay', () => {
  it('memoizes a completed tool step across a mid-run crash and its replay', async () => {
    const store = memoryThreadStore();
    const { tool, count } = countingTool();
    const agent = defineAgent({
      model: 'test-model',
      store,
      resolveRunIdentity: resolveTestRunIdentity,
      tools: { echo: tool },
    });

    let failTurn1 = true;

    // Turn 0 asks for a tool call; turn 1 is the final answer — but in pass 1 the
    // turn-1 generation throws AFTER the tool step has already completed.
    const generate: AgentGenerate = async ({ turn }) => {
      if (turn === 0) {
        return { text: '', toolCalls: [toolCall('echo', 'call-0', { value: 'hi' })] };
      }

      if (turn === 1) {
        if (failTurn1) {
          throw new Error('turn-1 boom');
        }

        return { text: 'all done', toolCalls: [] };
      }

      throw new Error(`unexpected turn ${String(turn)}`);
    };

    const params = { threadKey: 'thread-1', input: 'hello', runKey: 'run-1' };
    const agentHarness = createAgentHarness();

    // Pass 1: the run rejects, but the tool step has run exactly once.
    await expect(agentHarness.runAgent(agent, 'echoer', { params, generate })).rejects.toThrow(
      'turn-1 boom',
    );
    expect(count()).toBe(1);
    expect(agentHarness.harness.invocations('tool:echo:call-0')).toBe(1);
    expect(agentHarness.harness.invocations('llm:turn:0')).toBe(1);
    // The crashed turn never recorded a result.
    expect(agentHarness.harness.invocations('llm:turn:1')).toBe(1);

    // Pass 2: same definition, same durable log. The completed steps memoize; only
    // the post-crash turn runs anew.
    failTurn1 = false;
    const result = await agentHarness.runAgent(agent, 'echoer', { params, generate });

    expect(result.status).toBe('complete');
    expect(result.output?.stopped).toBe('final');
    expect(result.output?.text).toBe('all done');
    expect(result.output?.turns).toBe(2);

    // The tool body was NOT re-executed (memoized), while turn 1 ran fresh.
    expect(count()).toBe(1);
    expect(agentHarness.harness.invocations('tool:echo:call-0')).toBe(1);
    expect(agentHarness.harness.invocations('llm:turn:0')).toBe(1);
    expect(agentHarness.harness.invocations('llm:turn:1')).toBe(2);
  });
});
