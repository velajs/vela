/**
 * `defineAgent` — declare an agent once. This is pure validation plus a brand and
 * the bound `asTool` composer; the durable machinery lives in `compileAgent`
 * (which turns the declaration into a `@velajs/workflow` `WorkflowDefinition`).
 */
import { AgentError } from './errors';
import { agentAsTool } from './agent-as-tool';
import type { AgentConfig, AgentDefinition, Env } from './types';

/** Tool keys must be identifier-shaped so they map cleanly to the model's tool names. */
const TOOL_NAME_PATTERN = /^[A-Za-z][\w-]{0,63}$/;

/**
 * Validate and brand an agent declaration:
 *  - `model` is present and, if a string, non-empty;
 *  - `store` is present (the BYO persistence seam);
 *  - `maxTurns`, when set, is a positive integer;
 *  - every tool key matches `/^[A-Za-z][\w-]{0,63}$/`;
 *  - `memory`, when set, is inject-mode (graph/episodic/agentic are deferred).
 *
 * Attaches `isVelaAgent: true` and `asTool` (the bound `agentAsTool` composer).
 */
export const defineAgent = <Env2 extends Env = Env>(
  config: AgentConfig<Env2>,
): AgentDefinition<Env2> => {
  if (config.model === undefined || config.model === '') {
    throw new AgentError(
      'AGENT_MODEL_REQUIRED',
      'an agent needs a `model` (id, model object, or thunk)',
    );
  }

  if (config.store === undefined) {
    throw new AgentError(
      'AGENT_INVALID_STORE',
      'an agent needs a `store` (AgentThreadStore or thunk)',
    );
  }

  if (typeof config.resolveRunIdentity !== 'function') {
    throw new AgentError(
      'AGENT_RUN_IDENTITY_REQUIRED',
      'an agent needs `resolveRunIdentity` to derive a trusted ownerId and tenantId',
    );
  }

  if (
    config.maxTurns !== undefined &&
    (!Number.isSafeInteger(config.maxTurns) || config.maxTurns < 1 || config.maxTurns > 128)
  ) {
    throw new AgentError(
      'AGENT_INVALID_MAX_TURNS',
      '`maxTurns` must be an integer between 1 and 128',
    );
  }

  if (
    config.approvalTtlMs !== undefined &&
    (!Number.isSafeInteger(config.approvalTtlMs) || config.approvalTtlMs < 1)
  ) {
    throw new AgentError(
      'AGENT_INVALID_APPROVAL_TTL',
      '`approvalTtlMs` must be a positive safe integer',
    );
  }

  if (config.tools !== undefined) {
    for (const name of Object.keys(config.tools)) {
      if (
        !TOOL_NAME_PATTERN.test(name) ||
        ['__proto__', 'constructor', 'prototype'].includes(name)
      ) {
        throw new AgentError(
          'AGENT_INVALID_TOOL_NAME',
          `tool name "${name}" must match /^[A-Za-z][\\w-]*$/`,
        );
      }
    }
  }

  if (config.activeTools?.some((name) => !Object.hasOwn(config.tools ?? {}, name))) {
    throw new AgentError('AGENT_INVALID_TOOL_NAME', 'activeTools must reference declared tools');
  }
  if (config.memory?.key !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(config.memory.key)) {
    throw new AgentError('AGENT_INVALID_MEMORY_MODE', 'memory.key must be a bounded identifier');
  }
  if (
    config.memory?.topK !== undefined &&
    (!Number.isSafeInteger(config.memory.topK) ||
      config.memory.topK < 1 ||
      config.memory.topK > 100)
  ) {
    throw new AgentError('AGENT_INVALID_MEMORY_MODE', 'memory.topK must be between 1 and 100');
  }

  if (
    config.memory !== undefined &&
    config.memory.mode !== undefined &&
    config.memory.mode !== 'inject'
  ) {
    throw new AgentError(
      'AGENT_INVALID_MEMORY_MODE',
      `memory mode "${String(config.memory.mode)}" is not supported — only 'inject' is available this batch`,
    );
  }

  return {
    ...config,
    isVelaAgent: true,
    asTool: agentAsTool,
  };
};

/** True when `value` is a {@link defineAgent} result. */
export const isAgentDefinition = (value: unknown): value is AgentDefinition => {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { isVelaAgent?: unknown }).isVelaAgent === true
  );
};
