/** Compile a portable agent into a workflow definition. The optional Cloudflare
 * workflow-definitions entrypoint supplies native execution; /testing supplies an in-memory context. */
import { defineWorkflow } from '@velajs/workflow';
import { parseAgentRunParams } from './validation';
import type { WorkflowDefinition } from '@velajs/workflow';

import { runAgentLoop } from './agent-loop';
import { createAgentGenerate } from './generate';
import type { AgentGenerate } from './generate';
import { agentDefaultName } from './naming';
import type { AgentDefinition, AgentRunParams, AgentRunResult } from './types';

/** Advanced/testing overrides for {@link compileAgent}. */
export interface CompileAgentOptions {
  /**
   * Replace the AI-SDK generate seam. Production leaves this unset (the model is
   * resolved via {@link createAgentGenerate}); tests inject a scripted seam so no
   * real model is needed.
   */
  generate?: AgentGenerate;
}

/**
 * Turn an {@link AgentDefinition} into a durable workflow. `exportName` is the
 * agent's export identifier (drives the default deploy name and the naming
 * helpers); the compiled workflow's params are {@link AgentRunParams} and its
 * output is an {@link AgentRunResult}.
 */
export const compileAgent = (
  agent: AgentDefinition,
  exportName: string,
  options: CompileAgentOptions = {},
): WorkflowDefinition<AgentRunParams, AgentRunResult> =>
  defineWorkflow<AgentRunParams, AgentRunResult>({
    name: agent.name ?? agentDefaultName(exportName),
    handler: (ctx) => {
      const params = parseAgentRunParams(ctx.params);
      return runAgentLoop({
        agent,
        exportName,
        env: ctx.env,
        params,
        instanceId: ctx.event.instanceId,
        runKey: params.runKey ?? ctx.event.instanceId,
        step: ctx.step,
        run: ctx.run,
        log: ctx.log,
        store: typeof agent.store === 'function' ? agent.store(ctx.env) : agent.store,
        generate: options.generate ?? createAgentGenerate(agent, ctx.env),
        ...(agent.onThreadEvent !== undefined ? { onThreadEvent: agent.onThreadEvent } : {}),
      });
    },
  });
