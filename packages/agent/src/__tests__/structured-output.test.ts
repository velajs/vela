import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineAgent } from '../index';
import { createAgentHarness, finalTurn, memoryThreadStore, scriptedGenerate } from '../testing';
import { resolveTestRunIdentity, testThreadScope } from './support';

describe('structured output', () => {
  it('returns the parsed object and persists JSON when the final text is empty', async () => {
    const store = memoryThreadStore();
    const agent = defineAgent({
      model: 'test-model',
      store,
      resolveRunIdentity: resolveTestRunIdentity,
      output: z.object({ answer: z.string() }),
    });
    const agentHarness = createAgentHarness();

    const result = await agentHarness.runAgent(agent, 'structured', {
      params: { threadKey: 't-struct', input: 'q', runKey: 'run-struct' },
      generate: scriptedGenerate([finalTurn('', { answer: '42' })]),
    });

    expect(result.status).toBe('complete');
    expect(result.output?.stopped).toBe('final');
    expect(result.output?.output).toEqual({ answer: '42' });

    const rows = await store.listMessages(testThreadScope('t-struct', 'agent-structured'));
    const assistant = rows.find((row) => row.role === 'assistant');
    expect(assistant?.content).toBe(JSON.stringify({ answer: '42' }));
  });
});
