import { Controller, ENV, Inject, Injectable, Module, Post, Scope } from '@velajs/vela';
import { InternalDispatcher, SignedInvocation } from '@velajs/vela/dispatch';
import { defineWorkflow, WorkflowNonRetryableError } from '@velajs/workflow';
import { compileAgent, defineAgent, functionTool, type AgentApprovalEvent } from '@velajs/agent';
import {
  finalTurn,
  memoryThreadStore,
  scriptedGenerate,
  toolCallTurn,
} from '@velajs/agent/testing';
import { z } from 'zod';
import { defineCloudflareApp } from '../../index';
import { VelaEntrypoint } from '../../entrypoints';
import { VelaWorkflowDefinition } from '../../workflow-definitions';

@Injectable()
class PortableState {
  readonly store = memoryThreadStore();
  readonly attempts = new Map<string, number>();
  readonly rollbacks = new Map<string, number>();
  readonly approvals = new Map<string, Omit<AgentApprovalEvent, 'decision' | 'approverId'>>();
  readonly disposed: string[] = [];
  factories = 0;
  models = 0;
  tools = 0;
  dispatches = 0;
}

@Injectable({ scope: Scope.REQUEST })
class RunResource {
  readonly id = crypto.randomUUID();
  constructor(@Inject(PortableState) private readonly state: PortableState) {}
  dispose() {
    this.state.disposed.push(this.id);
  }
}

@Controller('/portable-result')
class ResultController {
  constructor(@Inject(PortableState) private readonly state: PortableState) {}
  @Post()
  @SignedInvocation()
  result() {
    this.state.dispatches++;
    return { accepted: true };
  }
}

@Injectable()
class ProbeHost {
  constructor(@Inject(PortableState) private readonly state: PortableState) {}
  snapshot() {
    return {
      attempts: Object.fromEntries(this.state.attempts),
      rollbacks: Object.fromEntries(this.state.rollbacks),
      disposed: this.state.disposed,
      factories: this.state.factories,
      models: this.state.models,
      tools: this.state.tools,
      dispatches: this.state.dispatches,
    };
  }
  async approval(threadKey: string) {
    const messages = await this.state.store.listMessages({
      threadKey,
      agent: 'agent-portable',
      ownerId: 'operator',
      tenantId: 'example-tenant',
    });
    return messages.find((message) => message.approval)?.approval ?? null;
  }
}

@Module({ providers: [PortableState, RunResource], controllers: [ResultController] })
class PortableApp {}
const app = defineCloudflareApp(PortableApp);

const params = z.object({
  value: z.string().regex(/^\d+$/).transform(Number),
  mode: z.enum(['plain', 'retry', 'terminal', 'rollback']).default('plain'),
});

export class PortableExampleWorkflow extends VelaWorkflowDefinition(app, {
  params,
  inject: [PortableState, RunResource, InternalDispatcher, ENV],
  useFactory: (state, resource, dispatcher, env) => {
    state.factories++;
    return {
      definition: defineWorkflow<
        z.output<typeof params>,
        { value: number; run: string; region: string }
      >({
        handler: async (ctx) => {
          const value = await ctx.step.do(
            'calculate',
            { retries: { limit: 2, delay: 1 } },
            async () => {
              const attempt = (state.attempts.get(ctx.event.instanceId) ?? 0) + 1;
              state.attempts.set(ctx.event.instanceId, attempt);
              if (ctx.params.mode === 'retry' && attempt === 1) throw new Error('transient');
              if (ctx.params.mode === 'terminal') throw new WorkflowNonRetryableError('terminal');
              return ctx.params.value * 2;
            },
            {
              rollback: async () => {
                state.rollbacks.set(
                  ctx.event.instanceId,
                  (state.rollbacks.get(ctx.event.instanceId) ?? 0) + 1,
                );
                if (ctx.params.mode === 'rollback')
                  throw new WorkflowNonRetryableError('terminal rollback');
              },
              rollbackConfig: { retries: { limit: 2, delay: 1 } },
            },
          );
          if (ctx.params.mode === 'rollback')
            await ctx.step.do('fail', async () => {
              throw new WorkflowNonRetryableError('start rollback');
            });
          await ctx.step.sleep('pause', '1 second');
          await ctx.step.do('dispatch', () => ctx.run({ path: '/portable-result' }));
          return { value, run: resource.id, region: String(Reflect.get(env, 'ENV_PROBE')) };
        },
      }),
      run: (target, init) => dispatcher.run(target, init),
    };
  },
}) {}

const agentParams = z.object({ threadKey: z.string(), input: z.string(), runKey: z.string() });

export class PortableAgentWorkflow extends VelaWorkflowDefinition(app, {
  params: agentParams,
  inject: [PortableState, InternalDispatcher],
  useFactory: (state, dispatcher) => {
    const script = scriptedGenerate([
      toolCallTurn([{ id: 'echo-1', name: 'echo', input: { value: 'hello' } }]),
      finalTurn('finished'),
    ]);
    const agent = defineAgent({
      model: 'test-model',
      store: state.store,
      // Fixture-owned identity, never copied from workflow trigger fields.
      resolveRunIdentity: () => ({ ownerId: 'operator', tenantId: 'example-tenant' }),
      verifyApproval: (approval) => approval.approverId === 'operator',
      tools: {
        echo: functionTool({
          description: 'Echo a test value after approval.',
          inputSchema: z.object({ value: z.string() }),
          needsApproval: true,
          execute: ({ value }) => {
            state.tools++;
            return value;
          },
        }),
      },
      onThreadEvent: (event) => {
        if (event.type === 'approval-requested')
          state.approvals.set(event.threadKey, event.approval);
      },
    });
    return {
      definition: compileAgent(agent, 'portable', {
        generate: async (input) => {
          state.models++;
          return script(input);
        },
      }),
      run: (target, init) => dispatcher.run(target, init),
    };
  },
}) {}

export class PortableProbe extends VelaEntrypoint(app, ProbeHost, {
  rpc: ['snapshot', 'approval'],
}) {}
