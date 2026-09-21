import { expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { createAi } from '@velajs/ai';
import { defineAgent } from '../index';
import { createAgentHarness, memoryThreadStore } from '../testing';
import { countingTool, resolveTestRunIdentity } from './support';

it('runs real AI SDK generation one durable turn at a time through a migrated model resolver', async () => {
  const usage = {
    inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const model = new MockLanguageModelV4({
    doGenerate: [
      {
        content: [
          { type: 'tool-call', toolCallId: 'echo-1', toolName: 'echo', input: '{"value":"hello"}' },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage,
        warnings: [],
      },
      {
        content: [{ type: 'text', text: 'finished' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage,
        warnings: [],
      },
    ],
  });
  const counter = countingTool();
  const agent = defineAgent({
    model: createAi({ defaultModel: model }).model(),
    store: memoryThreadStore(),
    resolveRunIdentity: resolveTestRunIdentity,
    tools: { echo: counter.tool },
  });
  const harness = createAgentHarness();
  const result = await harness.runAgent(agent, 'sdk', {
    params: { threadKey: 'sdk', input: 'hello' },
  });
  expect(result.output?.text).toBe('finished');
  expect(counter.count()).toBe(1);
  expect(harness.harness.invocations('tool:echo:echo-1')).toBe(1);
  expect(model.doGenerateCalls).toHaveLength(2);
  expect(result.output?.usage).toEqual({ inputTokens: 4, outputTokens: 2, totalTokens: 6 });
});
