import { describe, it, expect, beforeEach } from 'vitest';
import { NonRetryableError } from 'cloudflare:workflows';
import {
  APP_EXCEPTION_HANDLER,
  BadRequestException,
  Controller,
  Global,
  InternalServerErrorException,
  isVelaError,
  MetadataRegistry,
  Module,
  Post,
  SignedInvocation,
  URL_SIGNING_SECRET,
  VelaFactory,
} from '@velajs/vela';
import { defineWorkflow, WorkflowNonRetryableError } from '@velajs/workflow';
import type {
  WorkflowBindingLike,
  WorkflowEventLike,
  WorkflowInstanceLike,
  WorkflowRunFunction,
} from '@velajs/workflow';
import { createReplayHarness } from '@velajs/workflow/harness';
import { createCloudflareApp } from '../cloudflare-factory';
import { buildWorkflowRuntime } from '../workflow/build-workflow-runtime';
import {
  createWorkflowEntrypoint,
  createWorkflowEntrypoints,
  runWorkflowDefinition,
} from '../workflow/create-workflow-entrypoint';
import { WorkflowModule } from '../workflow/workflow.module';
import type { WorkflowEntrypointMeta } from '../workflow/tokens';

const SECRET = 'wp-a-workflow-signing-secret';

beforeEach(() => MetadataRegistry.clear());

// --- The "main Worker" app: signed routes a workflow re-enters via ctx.run -----

@Global()
@Module({
  providers: [
    { provide: URL_SIGNING_SECRET, useValue: SECRET },
    // Silence the report-first edge for the deliberate 5xx route.
    { provide: APP_EXCEPTION_HANDLER, useValue: { report() {} } },
  ],
  exports: [URL_SIGNING_SECRET, APP_EXCEPTION_HANDLER],
})
class SecretModule {}

@Controller('/orders')
class OrdersController {
  // The signed call carries a body (so the guard's bodyHash check is exercised
  // across the isolate hop), but the handler returns a fixed marker rather than
  // echoing it: vela's HTTP pipeline resolves args before guards, so reading the
  // body in the handler races the guard's own body read. What this route proves
  // is that the signed, body-bound request crossed isolates and passed the guard.
  @Post('get', { name: 'orders.get' })
  @SignedInvocation()
  get(): { ok: boolean; route: string } {
    return { ok: true, route: 'orders.get' };
  }

  @Post('boom4', { name: 'orders.boom4' })
  @SignedInvocation()
  boom4(): never {
    throw new BadRequestException('deterministic input error');
  }

  @Post('boom5', { name: 'orders.boom5' })
  @SignedInvocation()
  boom5(): never {
    throw new InternalServerErrorException('transient upstream error');
  }
}

@Module({ imports: [SecretModule], controllers: [OrdersController] })
class RoutesModule {}

/** A self-service binding backed by a real in-process app's `fetch`. */
const selfBindingFor = (fetch: (request: Request) => Response | Promise<Response>) => ({
  fetch: (request: Request): Promise<Response> => Promise.resolve(fetch(request)),
});

const makeEvent = <P>(payload: P): WorkflowEventLike<P> => ({
  instanceId: 'inst-1',
  payload,
  timestamp: new Date(0),
  workflowName: 'test',
});

/** A `ctx.run` double that must not be called (the handler throws before reaching it). */
const unusedRun: WorkflowRunFunction = () =>
  Promise.reject(new Error('ctx.run was not expected to run'));

describe('WP-A: cross-isolate workflow re-entry (ctx.run over a self-service binding)', () => {
  it('re-enters a @SignedInvocation() route across isolates and returns its body', async () => {
    const mainApp = await createCloudflareApp(RoutesModule);

    const orderPipeline = defineWorkflow<{ orderId: string }>({
      handler: (ctx) =>
        // The signed call is wrapped in a durable step, exactly as on the platform.
        ctx.step.do('fetch-order', () =>
          ctx.run<{ ok: boolean; route: string }>(
            { route: 'orders.get' },
            { body: { id: ctx.params.orderId } },
          ),
        ),
    });

    const runtime = await buildWorkflowRuntime({
      rootModule: RoutesModule,
      env: { SELF: selfBindingFor(mainApp.fetch) },
      serviceBinding: 'SELF',
      nonRetryableErrorClass: NonRetryableError,
    });

    const harness = createReplayHarness();
    const result = await harness.runToCompletion(orderPipeline, {
      params: { orderId: 'o-1' },
      run: runtime.run,
    });

    expect(result.status).toBe('complete');
    expect(result.output).toEqual({ ok: true, route: 'orders.get' });

    await runtime.close();
    await mainApp.close();
  });

  it('fails closed when the self-service binding is missing from env', async () => {
    const error = await buildWorkflowRuntime({
      rootModule: RoutesModule,
      env: {},
      serviceBinding: 'SELF',
      nonRetryableErrorClass: NonRetryableError,
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(isVelaError(error)).toBe(true);
    if (isVelaError(error)) {
      expect(error.message).toContain("service binding 'SELF' is missing");
    }
  });
});

describe('WP-A: NonRetryableError translation (the three paths)', () => {
  it('(a) translates a top-level WorkflowNonRetryableError into the native class', async () => {
    const def = defineWorkflow({
      handler: () => {
        throw new WorkflowNonRetryableError('invoice is void; a retry will never succeed');
      },
    });

    const harness = createReplayHarness();
    const error = await runWorkflowDefinition(def, {
      env: {},
      event: makeEvent({}),
      exportName: 'terminal',
      run: unusedRun,
      step: harness.step,
      nonRetryableErrorClass: NonRetryableError,
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(NonRetryableError);
    expect((error as Error).name).toBe('NonRetryableError');
  });

  it('(b) maps a deterministic 4xx from ctx.run into the native NonRetryableError', async () => {
    const mainApp = await createCloudflareApp(RoutesModule);
    const runtime = await buildWorkflowRuntime({
      rootModule: RoutesModule,
      env: { SELF: selfBindingFor(mainApp.fetch) },
      serviceBinding: 'SELF',
      nonRetryableErrorClass: NonRetryableError,
    });

    const error = await runtime.run({ route: 'orders.boom4' }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(NonRetryableError);

    await runtime.close();
    await mainApp.close();
  });

  it('(c) leaves a transient 5xx from ctx.run as a retryable VelaError', async () => {
    const mainApp = await createCloudflareApp(RoutesModule);
    const runtime = await buildWorkflowRuntime({
      rootModule: RoutesModule,
      env: { SELF: selfBindingFor(mainApp.fetch) },
      serviceBinding: 'SELF',
      nonRetryableErrorClass: NonRetryableError,
    });

    const error = await runtime.run({ route: 'orders.boom5' }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).not.toBeInstanceOf(NonRetryableError);
    expect(isVelaError(error)).toBe(true);
    if (isVelaError(error)) {
      expect(error.status).toBe(500);
    }

    await runtime.close();
    await mainApp.close();
  });
});

describe('WP-A: step mapping (native durable step threaded through the run context)', () => {
  it('threads the durable step into the context and memoizes step.do on replay', async () => {
    let bodyRuns = 0;
    const def = defineWorkflow<{ x: number }>({
      handler: (ctx) =>
        ctx.step.do('compute', () => {
          bodyRuns += 1;
          return Promise.resolve(ctx.params.x + 1);
        }),
    });

    const harness = createReplayHarness();

    const first = await runWorkflowDefinition(def, {
      env: {},
      event: makeEvent({ x: 1 }),
      exportName: 'compute-wf',
      run: unusedRun,
      step: harness.step,
      nonRetryableErrorClass: NonRetryableError,
    });
    expect(first).toBe(2);

    // Replay against the same persistent step log: the body is skipped (memoized).
    const second = await runWorkflowDefinition(def, {
      env: {},
      event: makeEvent({ x: 1 }),
      exportName: 'compute-wf',
      run: unusedRun,
      step: harness.step,
      nonRetryableErrorClass: NonRetryableError,
    });
    expect(second).toBe(2);
    expect(bodyRuns).toBe(1);
    expect(harness.invocations('compute')).toBe(1);
  });
});

// --- WorkflowModule / ctx.workflows / cf:workflow entrypoint ------------------

const orderPipeline = defineWorkflow<{ orderId: string }>({
  handler: (ctx) => Promise.resolve(ctx.params.orderId),
});

@Module({ imports: [WorkflowModule.forRoot({ workflows: { orderPipeline } })] })
class WorkflowAppModule {}

describe('WP-A: WorkflowModule + ctx.workflows + cf:workflow registry', () => {
  it('surfaces every workflow as a cf:workflow entrypoint with pure-derivation meta', async () => {
    const app = await VelaFactory.create(WorkflowAppModule);
    const entrypoints = app.entrypoints.ofKind<WorkflowEntrypointMeta>('cf:workflow');

    expect(entrypoints).toHaveLength(1);
    expect(entrypoints[0]?.meta).toEqual({
      exportName: 'orderPipeline',
      deployName: 'order-pipeline',
      className: 'OrderPipelineWorkflow',
      bindingName: 'WORKFLOW_ORDER_PIPELINE',
    });

    await app.close();
  });

  it('produces ctx.workflows handles that delegate to the resolved Workflow binding', async () => {
    const instance: WorkflowInstanceLike = {
      id: 'wf-instance-1',
      status: () => Promise.resolve({ status: 'queued' }),
      pause: () => Promise.resolve(),
      resume: () => Promise.resolve(),
      restart: () => Promise.resolve(),
      terminate: () => Promise.resolve(),
      sendEvent: () => Promise.resolve(),
    };
    const created: Array<{ params?: { orderId: string } }> = [];
    const fakeBinding: WorkflowBindingLike<{ orderId: string }> = {
      create: (options) => {
        created.push(options?.params !== undefined ? { params: options.params } : {});
        return Promise.resolve(instance);
      },
      createBatch: () => Promise.resolve([instance]),
      get: () => Promise.resolve(instance),
    };

    const runtime = await buildWorkflowRuntime({
      rootModule: WorkflowAppModule,
      env: {
        SELF: selfBindingFor(() => new Response()),
        WORKFLOW_ORDER_PIPELINE: fakeBinding,
      },
      serviceBinding: 'SELF',
      nonRetryableErrorClass: NonRetryableError,
    });

    expect(runtime.workflows).toBeDefined();
    const workflows = runtime.workflows;
    if (workflows === undefined) throw new Error('WorkflowsService should be resolvable');

    const handle = workflows.get<{ orderId: string }>('orderPipeline');
    const started = await handle.create({ params: { orderId: 'o-9' } });
    expect(started.id).toBe('wf-instance-1');
    expect(created).toEqual([{ params: { orderId: 'o-9' } }]);

    // An undeclared workflow throws the wire-consistent VelaError.
    const unknown = (() => {
      try {
        workflows.get('nope');
        return null;
      } catch (e: unknown) {
        return e;
      }
    })();
    expect(isVelaError(unknown)).toBe(true);

    await runtime.close();
  });
});

// --- Entrypoint class shape / naming ------------------------------------------

describe('WP-A: entrypoint class construction and naming', () => {
  it('names each generated class after workflowClassName so wrangler class_name matches', () => {
    const classes = createWorkflowEntrypoints({ orderPipeline }, { rootModule: WorkflowAppModule });

    expect(Object.keys(classes)).toEqual(['OrderPipelineWorkflow']);
    expect(typeof classes.OrderPipelineWorkflow).toBe('function');
  });

  it('createWorkflowEntrypoint returns a constructable class function', () => {
    const EntrypointClass = createWorkflowEntrypoint(orderPipeline, {
      rootModule: WorkflowAppModule,
      name: 'orderPipeline',
      serviceBinding: 'SELF',
    });

    expect(typeof EntrypointClass).toBe('function');
  });
});
