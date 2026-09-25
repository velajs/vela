import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import { Controller, ENV, Inject, Injectable, Module, Post, type VelaEnv } from '@velajs/vela';
import { InternalDispatcher, SignedInvocation } from '@velajs/vela/dispatch';
import { defineCloudflareApp } from '@velajs/cloudflare';
import { VelaWorkflow } from '@velajs/cloudflare/workflows';
import { compileAgent, defineAgent, functionTool, AGENT_APPROVAL_EVENT_TYPE } from '@velajs/agent';
import type { AgentRunResult } from '@velajs/agent';
import {
  AgentThreadDurableObject,
  agentRunParamsSchema,
  durableAgentThreadStore,
} from '@velajs/agent/cloudflare';
import { WorkflowNonRetryableError } from '@velajs/workflow';
import { runCloudflareWorkflow, workflowEventStream } from '@velajs/workflow/cloudflare';

export class Threads extends AgentThreadDurableObject {}
const identitySchema = z.object({
  DEMO_OWNER: z.string().trim().min(1),
  DEMO_TENANT: z.string().trim().min(1),
});
function identity(env: Cloudflare.Env) {
  const value = identitySchema.parse(env);
  return { ownerId: value.DEMO_OWNER, tenantId: value.DEMO_TENANT };
}
const scope = (env: Cloudflare.Env, threadKey: string) => ({
  ...identity(env),
  agent: 'reviewer',
  threadKey,
});

// A deterministic, side-effect-free route makes this example runnable without
// model credentials or an external service. The signature guard still runs.
@Controller('/internal')
class ReviewController {
  @Post('/acknowledge')
  @SignedInvocation()
  acknowledge() {
    return { acknowledged: true };
  }
}

@Injectable()
class ReviewHost {
  constructor(
    @Inject(ENV) private readonly env: VelaEnv,
    @Inject(InternalDispatcher) private readonly dispatcher: InternalDispatcher,
  ) {}

  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<AgentRunResult> {
    const store = durableAgentThreadStore(this.env.THREADS);
    const agent = defineAgent({
      name: 'reviewer',
      model: 'example/scripted',
      store,
      resolveRunIdentity: ({ ownerSelector, tenantSelector }) => {
        const trusted = identity(this.env);
        if (
          (ownerSelector !== undefined && ownerSelector !== trusted.ownerId) ||
          (tenantSelector !== undefined && tenantSelector !== trusted.tenantId)
        )
          throw new WorkflowNonRetryableError('Invalid identity selector');
        return trusted;
      },
      verifyApproval: (approval) =>
        store.verifyApproval(scope(this.env, approval.threadKey), approval),
      tools: {
        acknowledge: functionTool(
          { path: '/internal/acknowledge' },
          {
            description: 'Acknowledge a reviewed message',
            inputSchema: z.object({ message: z.string() }),
            needsApproval: true,
          },
        ),
      },
    });
    const definition = compileAgent(agent, 'reviewer', {
      generate: async ({ turn }) =>
        turn === 0
          ? {
              text: '',
              toolCalls: [{ id: 'ack-1', name: 'acknowledge', input: { message: 'Reviewed' } }],
            }
          : { text: 'Review complete', toolCalls: [] },
    });
    return runCloudflareWorkflow(definition, {
      schema: agentRunParamsSchema,
      event,
      step,
      env: { ...this.env },
      // The dispatcher signs each call and re-enters this environment's HTTP
      // pipeline. Injecting run never bypasses application authorization.
      run: (target, init) => this.dispatcher.run(target, init),
    });
  }
}

/* oxlint-disable typescript/no-extraneous-class -- Vela root module declaration. */
@Module({ controllers: [ReviewController] })
class AppModule {}
/* oxlint-enable typescript/no-extraneous-class */
const app = defineCloudflareApp(AppModule);
export class ReviewWorkflow extends VelaWorkflow(app, ReviewHost) {}

// This synthetic deployment has exactly one authenticated principal per env.
// The token grants access to all runs in that deployment. A multi-user service
// must replace this with verified identity and an instance-to-scope registry.
function authorize(request: Request, env: Cloudflare.Env): void {
  if (!env.DEMO_TOKEN || request.headers.get('authorization') !== `Bearer ${env.DEMO_TOKEN}`)
    throw new Response('Unauthorized', { status: 401 });
}
const createSchema = z
  .object({
    threadKey: z.string().min(1).max(256),
    runKey: z.string().min(1).max(256),
    input: z.string().max(4096),
  })
  .strict();
const decisionSchema = z
  .object({ threadKey: z.string(), nonce: z.string(), decision: z.enum(['approve', 'reject']) })
  .strict();

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/internal/')) return app.worker.fetch(request, env, ctx);
    try {
      authorize(request, env);
      if (request.method === 'POST' && url.pathname === '/runs') {
        const params = createSchema.parse(await request.json());
        const instance = await env.REVIEW.create({ id: crypto.randomUUID(), params });
        return Response.json({ id: instance.id }, { status: 201 });
      }
      const thread = /^\/threads\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'GET' && thread?.[1]) {
        return Response.json(
          await durableAgentThreadStore(env.THREADS).listMessages(scope(env, thread[1])),
        );
      }
      const run = /^\/runs\/([^/]+)\/(approve|events)$/.exec(url.pathname);
      if (!run?.[1]) return new Response('Not found', { status: 404 });
      const instance = await env.REVIEW.get(run[1]);
      if (request.method === 'POST' && run[2] === 'approve') {
        const input = decisionSchema.parse(await request.json());
        const store = durableAgentThreadStore(env.THREADS);
        const authorizedScope = scope(env, input.threadKey);
        const messages = await store.listMessages(authorizedScope);
        const challenge = messages.find((row) => row.approval?.nonce === input.nonce)?.approval;
        if (!challenge || challenge.instanceId !== instance.id)
          return new Response('Not found', { status: 404 });
        const approval = {
          ...challenge,
          decision: input.decision,
          approverId: identity(env).ownerId,
        };
        await store.recordApproval(authorizedScope, approval);
        await instance.sendEvent({ type: AGENT_APPROVAL_EVENT_TYPE, payload: approval });
        return new Response(null, { status: 204 });
      }
      if (request.method === 'GET' && run[2] === 'events') {
        const stream = await workflowEventStream({
          instance,
          authorize: () => authorize(request, env),
          signal: request.signal,
          filter: ['step_started', 'wait_started', 'workflow_completed', 'workflow_errored'],
        });
        const encoder = new TextEncoder();
        return new Response(
          stream.pipeThrough(
            new TransformStream({
              transform(event, controller) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
              },
            }),
          ),
          { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } },
        );
      }
      return new Response('Not found', { status: 404 });
    } catch (error) {
      if (error instanceof Response) return error;
      if (error instanceof z.ZodError) return new Response('Invalid input', { status: 400 });
      return new Response('Request failed', { status: 409 });
    }
  },
};
