import type { AgentToolCall } from './store';

/** The actual data available after a durable tool turn. */
export interface AgentCompletedTurn {
  text: string;
  toolCalls: ReadonlyArray<AgentToolCall>;
}

export type AgentStopCondition = (context: {
  steps: ReadonlyArray<AgentCompletedTurn>;
}) => boolean | Promise<boolean>;

export const stepCountIs = (count: number): AgentStopCondition => {
  if (!Number.isSafeInteger(count) || count < 1)
    throw new TypeError('count must be a positive integer');
  return ({ steps }) => steps.length >= count;
};

export const hasToolCall =
  (name: string): AgentStopCondition =>
  ({ steps }) =>
    steps.at(-1)?.toolCalls.some((call) => call.name === name) ?? false;
