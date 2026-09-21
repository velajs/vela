/**
 * Compose one agent as another agent's tool. The child runs as its own durable
 * workflow instance; the parent starts (or re-gets) it, polls its status until
 * terminal, and returns the child's final answer. The whole thing runs inside the
 * parent's `tool:<name>:<id>` step, so it is memoized — a retried parent step
 * reuses the SAME child (the child thread key and instance id derive
 * deterministically from the parent thread key and tool-call id).
 */
import { jsonSchema } from 'ai';

import { boundedText, canonicalJson, digestJson } from './validation';
import { AgentError } from './errors';
import { agentBindingName } from './naming';
import type {
  AgentAsToolOptions,
  AgentRunParams,
  AgentSubToolInput,
  AgentToolContext,
  AgentToolDefinition,
  Env,
} from './types';
import { defineAgentTool } from './tools';
import type {
  WorkflowBindingLike,
  WorkflowInstanceLike,
  WorkflowStatusResult,
} from '@velajs/workflow';

const DEFAULT_MAX_POLLS = 60;
const DEFAULT_POLL_INTERVAL_MS = 500;

/** Read the child's final answer out of its `AgentRunResult` output. */
const extractAnswer = (output: unknown): string => {
  if (typeof output === 'string') {
    return boundedText(output);
  }

  if (output !== null && typeof output === 'object') {
    const result = output as { text?: unknown; output?: unknown };

    if (typeof result.text === 'string' && result.text.length > 0) {
      return boundedText(result.text);
    }

    if (result.output !== undefined) {
      return canonicalJson(result.output);
    }
  }

  return '';
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Start the child instance, or re-get it if this parent step already created it. */
const startOrGet = async (
  binding: WorkflowBindingLike<AgentRunParams>,
  id: string,
  params: AgentRunParams,
): Promise<WorkflowInstanceLike> => {
  try {
    return await binding.create({ id, params });
  } catch {
    // An instance with this id already exists (a retried parent step) — reuse it.
    return binding.get(id);
  }
};

/**
 * Build a tool that runs a child agent. `options.name` is the child's export name;
 * its workflow binding is looked up on `env` under `agentBindingName(name)`.
 */
export const agentAsTool = (
  options: AgentAsToolOptions,
): AgentToolDefinition<AgentSubToolInput, string> => {
  const maxPolls = options.maxPolls ?? DEFAULT_MAX_POLLS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const bindingName = agentBindingName(options.name);
  if (
    options.wait === false ||
    !Number.isSafeInteger(maxPolls) ||
    maxPolls < 1 ||
    maxPolls > 120 ||
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 0 ||
    pollIntervalMs * maxPolls > 60000
  ) {
    throw new AgentError(
      'AGENT_SUBAGENT_FAILED',
      'Sub-agents require wait=true, 1–120 polls, and a polling budget of at most 60 seconds',
    );
  }

  return defineAgentTool<AgentSubToolInput, string>({
    description: options.description,
    inputSchema: jsonSchema<AgentSubToolInput>({
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task for the sub-agent to work on.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    }),
    execute: async (
      input: AgentSubToolInput,
      ctx: AgentToolContext<Env, AgentSubToolInput>,
    ): Promise<string> => {
      const binding = ctx.env[bindingName] as WorkflowBindingLike<AgentRunParams> | undefined;

      if (
        binding === undefined ||
        typeof binding.create !== 'function' ||
        typeof binding.get !== 'function'
      ) {
        throw new AgentError(
          'AGENT_SUBAGENT_BINDING_MISSING',
          `sub-agent "${options.name}" is not bound on env as "${bindingName}"`,
        );
      }

      // Replay-stable identifiers derived from the parent thread + this tool call.
      const childRunKey = `sub-${await digestJson([
        ctx.tenantId,
        ctx.ownerId,
        ctx.threadKey,
        ctx.runKey,
        options.name,
        ctx.toolCallId,
      ])}`;
      const childThreadKey = childRunKey;

      const instance = await startOrGet(binding, childRunKey, {
        threadKey: childThreadKey,
        input: input.prompt,
        runKey: childRunKey,
        owner: ctx.ownerId,
        tenantId: ctx.tenantId,
      });

      for (let poll = 0; poll < maxPolls; poll += 1) {
        const status: WorkflowStatusResult = await instance.status();

        if (status.status === 'complete') {
          return extractAnswer(status.output);
        }

        if (status.status === 'errored') {
          throw new AgentError(
            'AGENT_SUBAGENT_FAILED',
            `sub-agent "${options.name}" errored: ${status.error?.message ?? 'unknown error'}`,
          );
        }

        if (status.status === 'terminated') {
          throw new AgentError(
            'AGENT_SUBAGENT_FAILED',
            `sub-agent "${options.name}" was terminated`,
          );
        }

        if (poll < maxPolls - 1 && pollIntervalMs > 0) {
          await delay(pollIntervalMs);
        }
      }

      throw new AgentError(
        'AGENT_SUBAGENT_FAILED',
        `sub-agent "${options.name}" did not reach a terminal state within ${String(maxPolls)} polls`,
      );
    },
  });
};
