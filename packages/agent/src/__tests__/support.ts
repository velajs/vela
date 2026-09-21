import { z } from 'zod';
import type { WorkflowRunFunction } from '@velajs/workflow';

import { functionTool } from '../tools';
import type {
  AgentApprovalEvent,
  AgentThreadEvent,
  AgentToolCall,
  AgentToolContext,
  AnyAgentTool,
} from '../index';

export const TEST_RUN_IDENTITY = {
  ownerId: 'test-owner',
  tenantId: 'test-tenant',
} as const;

export const resolveTestRunIdentity = () => TEST_RUN_IDENTITY;

export const testThreadScope = (threadKey: string, agent: string) => ({
  threadKey,
  agent,
  ...TEST_RUN_IDENTITY,
});

/** A minimal, fully-typed {@link AgentToolContext} for calling a tool `execute` directly. */
export const fakeToolContext = <Input>(
  input: Input,
): AgentToolContext<Record<string, unknown>, Input> => {
  const run: WorkflowRunFunction = (): Promise<unknown> =>
    Promise.reject(new Error('run is not available in fakeToolContext'));

  return {
    input,
    env: {},
    idempotencyKey: 'tool:test:0',
    toolCallId: '0',
    threadKey: 'thread-test',
    runKey: 'run-test',
    ...TEST_RUN_IDENTITY,
    thread: { list: async () => [] },
    run,
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    reportProgress: () => undefined,
  };
};

/** A tool that counts how many times its `execute` body actually ran. */
export interface CountingTool {
  // AnyAgentTool is the documented variance hatch — a concretely-typed tool is
  // assignable to it, and the agent's `tools` map holds `AnyAgentTool` anyway.
  tool: AnyAgentTool;
  count: () => number;
  lastInput: () => unknown;
}

/**
 * A tool whose `execute` increments a counter — the probe for "did the tool body
 * run?" across replays and duplicate deliveries. `echo` returns the input's `value`.
 */
export const countingTool = (
  options: { needsApproval?: boolean | (() => boolean) } = {},
): CountingTool => {
  let calls = 0;
  let seen: unknown;

  const tool = functionTool({
    description: 'Echo the provided value back, counting each execution.',
    inputSchema: z.object({ value: z.string() }),
    execute: (input: { value: string }): string => {
      calls += 1;
      seen = input;

      return `echoed:${input.value}`;
    },
    ...(options.needsApproval !== undefined ? { needsApproval: options.needsApproval } : {}),
  });

  return { tool, count: () => calls, lastInput: () => seen };
};

/** A deterministic tool-call descriptor for scripted generate turns. */
export const toolCall = (name: string, id: string, input: unknown): AgentToolCall => ({
  id,
  name,
  input,
});

/** Collect the live thread events an agent emits, for assertions. */
export interface EventCollector {
  sink: (event: AgentThreadEvent) => void;
  events: AgentThreadEvent[];
  ofType: <T extends AgentThreadEvent['type']>(
    type: T,
  ) => Array<Extract<AgentThreadEvent, { type: T }>>;
}

export const eventCollector = (): EventCollector => {
  const events: AgentThreadEvent[] = [];

  return {
    sink: (event) => {
      events.push(event);
    },
    events,
    ofType: <T extends AgentThreadEvent['type']>(type: T) =>
      events.filter(
        (event): event is Extract<AgentThreadEvent, { type: T }> => event.type === type,
      ),
  };
};

/** Build a fully-bound approval payload from the loop's live request event. */
export const approvalPayload = (
  collector: EventCollector,
  decision: AgentApprovalEvent['decision'],
  note?: string,
): AgentApprovalEvent => {
  const requested = collector.ofType('approval-requested').at(-1);
  if (requested === undefined) throw new Error('no approval request was emitted');
  return {
    ...requested.approval,
    decision,
    approverId: 'test-approver',
    ...(note !== undefined ? { note } : {}),
  };
};
