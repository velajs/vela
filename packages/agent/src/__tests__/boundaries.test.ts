import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineAgent, functionTool, hasToolCall, messageKey } from '../index';
import {
  createAgentHarness,
  finalTurn,
  memoryRag,
  memoryThreadStore,
  scriptedGenerate,
  toolCallTurn,
} from '../testing';
import { countingTool, resolveTestRunIdentity, toolCall } from './support';

describe('durable run boundaries', () => {
  it('rejects a competing instance and changed input before calling any model or tool', async () => {
    const store = memoryThreadStore();
    const counter = countingTool({ needsApproval: true });
    const agent = defineAgent({
      model: 'test',
      store,
      resolveRunIdentity: resolveTestRunIdentity,
      tools: { echo: counter.tool },
    });
    const generate = scriptedGenerate([
      toolCallTurn([toolCall('echo', 'call', { value: 'hello' })]),
    ]);
    const params = { threadKey: 'thread', runKey: 'run', input: 'hello' };
    expect((await createAgentHarness().runAgent(agent, 'demo', { params, generate })).status).toBe(
      'suspended',
    );
    const duplicate = createAgentHarness();
    await expect(duplicate.runAgent(agent, 'demo', { params, generate })).rejects.toThrow(
      /active workflow/,
    );
    expect(duplicate.harness.invocations('llm:turn:0')).toBe(0);
    await expect(
      createAgentHarness().runAgent(agent, 'demo', {
        params: { ...params, input: 'changed' },
        generate,
      }),
    ).rejects.toThrow(/different input/);
    await expect(
      createAgentHarness().runAgent(agent, 'demo', {
        params: { ...params, runKey: 'another' },
        generate,
      }),
    ).rejects.toThrow(/active workflow/);
    expect(counter.count()).toBe(0);
  });

  it('validates all arguments before the first tool effect', async () => {
    const counter = countingTool();
    const agent = defineAgent({
      model: 'test',
      store: memoryThreadStore(),
      resolveRunIdentity: resolveTestRunIdentity,
      tools: { echo: counter.tool },
    });
    await expect(
      createAgentHarness().runAgent(agent, 'demo', {
        params: { threadKey: 'thread', input: 'hello' },
        generate: scriptedGenerate([
          toolCallTurn([
            toolCall('echo', 'valid', { value: 'ok' }),
            toolCall('echo', 'invalid', { value: 42 }),
          ]),
        ]),
      }),
    ).rejects.toThrow(/inputSchema/);
    expect(counter.count()).toBe(0);
  });

  it('scopes idempotency keys across runs and forwards them to route dispatch', async () => {
    const keys: string[] = [];
    const route = functionTool(
      { path: '/charge' },
      { description: 'Charge', inputSchema: z.object({ value: z.string() }) },
    );
    const store = memoryThreadStore();
    const agent = defineAgent({
      model: 'test',
      store,
      resolveRunIdentity: resolveTestRunIdentity,
      tools: { charge: route },
    });
    for (const runKey of ['first', 'second']) {
      await createAgentHarness().runAgent(agent, 'demo', {
        params: { threadKey: 'thread', runKey, input: 'go' },
        generate: scriptedGenerate([
          toolCallTurn([toolCall('charge', 'same-call', { value: 'ok' })]),
          finalTurn('done'),
        ]),
        run: async (_target, init) => {
          keys.push(new Headers(init?.headers).get('Idempotency-Key')!);
          return { ok: true };
        },
      });
    }
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^agent-[a-f0-9]{64}$/);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('bounds untrusted tool and retrieval results', async () => {
    const tooLarge = 'x'.repeat(256 * 1024 + 1);
    const oversized = functionTool({
      description: 'Too big',
      inputSchema: z.object({}),
      execute: () => tooLarge,
    });
    const base = { model: 'test', resolveRunIdentity: resolveTestRunIdentity };
    await expect(
      createAgentHarness().runAgent(
        defineAgent({ ...base, store: memoryThreadStore(), tools: { oversized } }),
        'demo',
        {
          params: { threadKey: 'thread', input: 'go' },
          generate: scriptedGenerate([toolCallTurn([toolCall('oversized', 'call', {})])]),
        },
      ),
    ).rejects.toThrow(/UTF-8/);
    await expect(
      createAgentHarness().runAgent(
        defineAgent({
          ...base,
          store: memoryThreadStore(),
          memory: { rag: memoryRag({ context: tooLarge }) },
        }),
        'demo',
        {
          params: { threadKey: 'thread', input: 'go' },
          generate: scriptedGenerate([finalTurn('done')]),
        },
      ),
    ).rejects.toThrow(/UTF-8/);
  });

  it('uses the real agent tool name in hasToolCall and defaults RAG auth to run identity', async () => {
    const counter = countingTool();
    const rag = memoryRag();
    const agent = defineAgent({
      model: 'test',
      store: memoryThreadStore(),
      resolveRunIdentity: resolveTestRunIdentity,
      tools: { echo: counter.tool },
      memory: { rag },
      stopWhen: hasToolCall('echo'),
    });
    const result = await createAgentHarness().runAgent(agent, 'demo', {
      params: { threadKey: 'thread', input: 'go' },
      generate: scriptedGenerate([toolCallTurn([toolCall('echo', 'call', { value: 'ok' })])]),
    });
    expect(result.output?.stopped).toBe('stopCondition');
    expect(rag.queries()[0]?.options).toMatchObject({
      namespace: 'test-tenant',
      auth: resolveTestRunIdentity(),
    });
  });

  it('keeps message-key tuples unambiguous', () => {
    expect(messageKey('a:tool', 'user')).not.toBe(messageKey('a', 'tool', 'user'));
  });
});
