import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineAgent, isAgentDefinition } from '../index';
import { memoryThreadStore } from '../testing';
import { countingTool, resolveTestRunIdentity } from './support';

describe('defineAgent validation', () => {
  it('brands the definition and attaches asTool', () => {
    const agent = defineAgent({
      model: 'test-model',
      store: memoryThreadStore(),
      resolveRunIdentity: resolveTestRunIdentity,
    });

    expect(agent.isVelaAgent).toBe(true);
    expect(typeof agent.asTool).toBe('function');
    expect(isAgentDefinition(agent)).toBe(true);
    expect(isAgentDefinition({})).toBe(false);
    expect(isAgentDefinition(null)).toBe(false);
  });

  it('throws on an empty-string model', () => {
    expect(() =>
      defineAgent({
        model: '',
        store: memoryThreadStore(),
        resolveRunIdentity: resolveTestRunIdentity,
      }),
    ).toThrow(/model/);
  });

  it('throws on a non-positive or non-integer maxTurns', () => {
    expect(() =>
      defineAgent({
        model: 'm',
        store: memoryThreadStore(),
        resolveRunIdentity: resolveTestRunIdentity,
        maxTurns: 0,
      }),
    ).toThrow(/maxTurns/);
    expect(() =>
      defineAgent({
        model: 'm',
        store: memoryThreadStore(),
        resolveRunIdentity: resolveTestRunIdentity,
        maxTurns: 1.5,
      }),
    ).toThrow(/maxTurns/);
  });

  it('throws on a tool key that is not identifier-shaped', () => {
    const { tool } = countingTool();

    expect(() =>
      defineAgent({
        model: 'm',
        store: memoryThreadStore(),
        resolveRunIdentity: resolveTestRunIdentity,
        tools: { 'has space': tool },
      }),
    ).toThrow(/tool name/);
  });

  it('throws on a non-inject memory mode', () => {
    const rag = { retrieve: async () => ({ context: '', chunks: [], sources: [] }) };

    expect(() =>
      defineAgent({
        model: 'm',
        store: memoryThreadStore(),
        resolveRunIdentity: resolveTestRunIdentity,
        // @ts-expect-error only 'inject' is allowed this batch
        memory: { rag, mode: 'graph' },
      }),
    ).toThrow(/inject/);
  });

  it('accepts a full valid config', () => {
    const { tool } = countingTool();
    const agent = defineAgent({
      model: 'm',
      store: memoryThreadStore(),
      resolveRunIdentity: resolveTestRunIdentity,
      instructions: 'be helpful',
      tools: { echo: tool },
      activeTools: ['echo'],
      maxTurns: 4,
      output: z.object({ ok: z.boolean() }),
      temperature: 0.2,
      maxOutputTokens: 512,
    });

    expect(agent.isVelaAgent).toBe(true);
  });
});
