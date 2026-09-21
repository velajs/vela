import { describe, expect, it } from 'vitest';

import {
  agentBindingName,
  agentClassName,
  agentDefaultName,
  approvalWaitName,
  llmTurnStepName,
  MEMORY_STEP_BASE,
  memoryStepName,
  messageKey,
  toolStepName,
} from '../index';

describe('agent naming helpers', () => {
  it('derives class / binding / deploy names from an export name', () => {
    expect(agentClassName('support')).toBe('SupportAgentWorkflow');
    expect(agentBindingName('support')).toBe('AGENT_SUPPORT');
    expect(agentDefaultName('support')).toBe('agent-support');

    expect(agentClassName('customerSupport')).toBe('CustomerSupportAgentWorkflow');
    expect(agentBindingName('customerSupport')).toBe('AGENT_CUSTOMER_SUPPORT');
    expect(agentDefaultName('customerSupport')).toBe('agent-customer-support');
  });
});

describe('deterministic step-name + message-key grammar', () => {
  it('derives durable step names', () => {
    expect(llmTurnStepName(0)).toBe('llm:turn:0');
    expect(llmTurnStepName(7)).toBe('llm:turn:7');
    expect(toolStepName('echo', 'abc')).toBe('tool:echo:abc');
    expect(approvalWaitName(2, 'echo', 'abc')).toBe('approval:2:echo:abc');
    expect(memoryStepName(MEMORY_STEP_BASE, undefined)).toBe('memory:retrieve');
    expect(memoryStepName(MEMORY_STEP_BASE, 'default')).toBe('memory:retrieve');
    expect(memoryStepName(MEMORY_STEP_BASE, 'docs')).toBe('memory:retrieve:docs');
  });

  it('derives message keys', () => {
    expect(messageKey('run', 'user')).toBe('run:user');
    expect(messageKey('run', 'assistant', '0')).toBe('run:assistant:0');
    expect(messageKey('run', 'tool', 'id1')).toBe('run:tool:id1');
    expect(messageKey('run', 'approval', 'id1')).toBe('run:approval:id1');
  });

  it('is a pure function of its inputs (no wall-clock / randomness)', () => {
    expect(llmTurnStepName(3)).toBe(llmTurnStepName(3));
    expect(toolStepName('t', 'x')).toBe(toolStepName('t', 'x'));
    expect(messageKey('r', 'tool', 'id')).toBe(messageKey('r', 'tool', 'id'));
  });
});
