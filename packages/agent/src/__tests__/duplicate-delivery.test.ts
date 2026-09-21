import { describe, expect, it } from 'vitest';

import { defineAgent } from '../index';
import type { AgentGenerate } from '../index';
import {
  createAgentHarness,
  finalTurn,
  memoryThreadStore,
  scriptedGenerate,
  toolCallTurn,
} from '../testing';
import {
  countingTool,
  eventCollector,
  resolveTestRunIdentity,
  testThreadScope,
  toolCall,
} from './support';

describe('completed duplicate delivery returns the stored run result', () => {
  it('dedups every message key on a second delivery with the same runKey', async () => {
    const store = memoryThreadStore();
    const { tool, count } = countingTool();
    const collector = eventCollector();

    const agent = defineAgent({
      model: 'test-model',
      store,
      resolveRunIdentity: resolveTestRunIdentity,
      tools: { echo: tool },
      onThreadEvent: collector.sink,
    });

    const generate: AgentGenerate = scriptedGenerate([
      toolCallTurn([toolCall('echo', 'call-0', { value: 'hi' })]),
      finalTurn('done'),
    ]);

    const params = { threadKey: 'thread-dup', input: 'hello', runKey: 'run-dup' };

    // Delivery 1: a full run through one instance's durable log.
    const first = createAgentHarness();
    const firstResult = await first.runAgent(agent, 'echoer', { params, generate });
    expect(firstResult.status).toBe('complete');

    const afterFirst = await store.listMessages(testThreadScope('thread-dup', 'agent-echoer'));
    const messageEventsAfterFirst = collector.ofType('message').length;
    expect(messageEventsAfterFirst).toBeGreaterThan(0);

    // Delivery 2: a FRESH instance/durable log (steps are NOT memoized), but the
    // SAME { threadKey, runKey, input }. The completed claim returns its result
    // before any new model call, effect, or persistence operation.
    const second = createAgentHarness();
    const secondResult = await second.runAgent(agent, 'echoer', { params, generate });
    expect(secondResult.status).toBe('complete');
    expect(secondResult.output).toEqual(firstResult.output);
    expect(count()).toBe(1);
    expect(second.harness.invocations('llm:turn:0')).toBe(0);

    const afterSecond = await store.listMessages(testThreadScope('thread-dup', 'agent-echoer'));

    // No new rows, identical sequence.
    expect(afterSecond.length).toBe(afterFirst.length);
    expect(afterSecond.map((message) => message.seq)).toEqual(
      afterFirst.map((message) => message.seq),
    );

    // The second delivery emitted no message events (every append deduped).
    expect(collector.ofType('message').length).toBe(messageEventsAfterFirst);
  });
});
