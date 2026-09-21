import { describe, expect, expectTypeOf, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { Rag } from '@velajs/ai/rag';

import { compileAgent, defineAgent } from '../index';
import type {
  AgentDefinition,
  AgentConfig,
  AgentModelInput,
  AgentRunParams,
  AgentRunResult,
  AgentThreadStore,
  RagLike,
} from '../index';
import { memoryThreadStore } from '../testing';
import { resolveTestRunIdentity } from './support';
import type { WorkflowDefinition } from '@velajs/workflow';

describe('type conformance (no casts)', () => {
  it('Pick<Rag, "retrieve"> satisfies the local RagLike seam', () => {
    // If `@velajs/ai/rag`'s Rag['retrieve'] drifts from RagLike, this stops compiling.
    const conform = (rag: Pick<Rag, 'retrieve'>): RagLike => rag;
    expect(typeof conform).toBe('function');
  });

  it('AgentModelInput accepts a model object, a thunk, and a bare id', () => {
    const asObject: AgentModelInput = new MockLanguageModelV4();
    const asThunk: AgentModelInput = () => new MockLanguageModelV4();
    const asId: AgentModelInput = 'openai/gpt-4o';

    expect(asObject).toBeDefined();
    expect(typeof asThunk).toBe('function');
    expect(asId).toBe('openai/gpt-4o');
  });

  it('memoryThreadStore is assignable to AgentThreadStore', () => {
    const store: AgentThreadStore = memoryThreadStore();
    expect(store).toBeDefined();
    expectTypeOf(memoryThreadStore()).toMatchTypeOf<AgentThreadStore>();
  });

  it('createAgentGenerate uses a MockLanguageModelV4 through defineAgent', () => {
    const agent = defineAgent({
      model: new MockLanguageModelV4(),
      store: memoryThreadStore(),
      resolveRunIdentity: resolveTestRunIdentity,
    });
    expectTypeOf(agent).toMatchTypeOf<AgentDefinition>();
  });

  it('requires a run identity resolver in AgentConfig', () => {
    // @ts-expect-error resolveRunIdentity is the mandatory runtime trust boundary
    const config: AgentConfig = { model: 'test-model', store: memoryThreadStore() };
    expect(config).toBeDefined();
  });

  it('compileAgent returns a WorkflowDefinition over the agent run params/result', () => {
    expectTypeOf(compileAgent).returns.toEqualTypeOf<
      WorkflowDefinition<AgentRunParams, AgentRunResult>
    >();
  });
});
