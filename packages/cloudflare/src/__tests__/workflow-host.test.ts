import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  APP_EXCEPTION_HANDLER,
  Catch,
  Controller,
  ENV,
  ForbiddenException,
  Get,
  Inject,
  InjectionToken,
  Injectable,
  Module,
  Scope,
  UseFilters,
  UseGuards,
  UseInterceptors,
  defineProvider,
  type CallHandler,
  type CanActivate,
  type ErrorReportContext,
  type ExceptionFilter,
  type ExecutionContext as PipelineContext,
  type NestInterceptor,
  type VelaEnv,
} from '@velajs/vela';
import type { EntrypointExecutionContext, RuntimeAdapter } from '@velajs/vela/module-kit';
import { cloudflareApplication } from '../cloudflare-factory';
import {
  CLOUDFLARE_WORKER,
  CLOUDFLARE_WORKFLOW,
  defineCloudflareApp,
  type CloudflareApp,
} from '../index';
import { VelaWorkflow, type WorkflowParams } from '../workflows';

/** What each application reported, with its report context. */
const REPORTS = new InjectionToken<{ error: unknown; context: ErrorReportContext }[]>('reports');

const reporting: RuntimeAdapter = {
  name: 'reports',
  configureContainer(container) {
    const reports: { error: unknown; context: ErrorReportContext }[] = [];
    container.register(defineProvider(REPORTS, { useValue: reports }));
    container.markGlobalToken(REPORTS);
    container.register(
      defineProvider(APP_EXCEPTION_HANDLER, {
        useValue: { report: (error: unknown, context) => void reports.push({ error, context }) },
      }),
    );
  },
};

/**
 * The Workflows engine's step, as far as these runs use it: `do` runs the
 * callback once, and `sleep` returns at once unless the run passes its own.
 */
function engineStep(
  sleep: WorkflowStep['sleep'] = async () => {},
): WorkflowStep & { readonly done: string[] } {
  const done: string[] = [];
  return {
    done,
    async do<T>(name: string, ...rest: unknown[]): Promise<T> {
      done.push(name);
      const callback = rest.find((value) => typeof value === 'function');
      if (typeof callback !== 'function') throw new TypeError('step.do needs a callback');
      return Reflect.apply(callback, undefined, [
        { step: { name, count: 1 }, attempt: 1, config: {} },
      ]);
    },
    sleep,
    sleepUntil: async () => {},
    async waitForEvent() {
      throw new Error('no events in this test');
    },
  };
}

function signupEvent(email: string): WorkflowEvent<{ email: string }> {
  return {
    payload: { email },
    timestamp: new Date(0),
    instanceId: `signup-${email}`,
    workflowName: 'signups',
  };
}

function isPlatformContext(value: object): value is ExecutionContext {
  return 'waitUntil' in value && 'props' in value;
}

/** The platform's ExecutionContext of a Workflow run; these runs read nothing from it. */
function platformContext(): ExecutionContext {
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {}, exports: {} };
  if (!isPlatformContext(ctx)) throw new Error('Not an execution context.');
  return ctx;
}

/** The HTTP context the Worker's fetch handler receives. */
const httpContext = { waitUntil() {}, passThroughOnException() {}, props: {} };

/** What the app's Worker application for `env` reported. */
async function reportsOf(
  app: CloudflareApp,
  env: VelaEnv,
): Promise<{ error: unknown; context: ErrorReportContext }[]> {
  return (await cloudflareApplication(app, env)).get(REPORTS);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected a rejection');
}

describe('VelaWorkflow', () => {
  it('runs the host in the Worker application of its environment, with a scope per run', async () => {
    let runs = 0;
    @Injectable()
    class Users {
      readonly created: string[] = [];
    }
    @Injectable({ scope: Scope.REQUEST })
    class RunTrace {
      readonly id = ++runs;
    }
    @Injectable()
    class SignupHost {
      constructor(
        private readonly users: Users,
        @Inject(RunTrace) private readonly trace: RunTrace,
        @Inject(ENV) private readonly env: VelaEnv,
      ) {}
      async run(event: WorkflowEvent<{ email: string }>, step: WorkflowStep) {
        const id = await step.do('create user', async () => {
          this.users.created.push(event.payload.email);
          return `user:${event.payload.email}`;
        });
        return { id, run: this.trace.id, region: Reflect.get(this.env, 'REGION') };
      }
    }
    @Controller('/users')
    class UsersController {
      constructor(private readonly users: Users) {}
      @Get()
      list(): string[] {
        return this.users.created;
      }
    }
    @Module({ controllers: [UsersController], providers: [Users, RunTrace] })
    class AppModule {}

    const app = defineCloudflareApp(AppModule);
    class Signup extends VelaWorkflow(app, SignupHost) {}
    expectTypeOf<WorkflowParams<typeof Signup>>().toEqualTypeOf<Readonly<{ email: string }>>();

    const env = { REGION: 'eu' };
    const step = engineStep();
    const workflow = new Signup(platformContext(), env);
    expect(await workflow.run(signupEvent('ada@example.com'), step)).toEqual({
      id: 'user:ada@example.com',
      run: 1,
      region: 'eu',
    });
    expect(step.done).toEqual(['create user']);
    // A second run gets its own request scope, in the same application.
    expect(await workflow.run(signupEvent('grace@example.com'), step)).toMatchObject({ run: 2 });
    // The Worker's own handlers use that application: its singletons are shared.
    const response = await app.worker.fetch(
      new Request('https://worker.test/users'),
      env,
      httpContext,
    );
    expect(await response.json()).toEqual(['ada@example.com', 'grace@example.com']);

    // Another environment identity is another application.
    const otherEnv = { REGION: 'us' };
    const other = new Signup(platformContext(), otherEnv);
    expect(await other.run(signupEvent('alan@example.com'), step)).toMatchObject({
      region: 'us',
      run: 3,
    });
    const otherResponse = await app.worker.fetch(
      new Request('https://worker.test/users'),
      otherEnv,
      httpContext,
    );
    expect(await otherResponse.json()).toEqual(['alan@example.com']);
  });

  it('passes the platform event and step through untouched', async () => {
    const received: unknown[] = [];
    @Injectable()
    class EchoHost {
      async run(event: WorkflowEvent<{ n: number }>, step: WorkflowStep): Promise<number> {
        received.push(event, step);
        return event.payload.n;
      }
    }
    @Module({})
    class AppModule {}
    const app = defineCloudflareApp(AppModule);
    class Echo extends VelaWorkflow(app, EchoHost) {}
    const event: WorkflowEvent<{ n: number }> = {
      payload: { n: 7 },
      timestamp: new Date(0),
      instanceId: 'echo',
      workflowName: 'echo',
    };
    const step = engineStep();
    expect(await new Echo(platformContext(), {}).run(event, step)).toBe(7);
    expect(received[0]).toBe(event);
    expect(received[1]).toBe(step);
  });

  it('runs scoped guards, interceptors and filters with a cf:workflow ExecutionContext', async () => {
    const seen: EntrypointExecutionContext[] = [];
    @Injectable()
    class Observe implements CanActivate {
      canActivate(context: EntrypointExecutionContext): boolean {
        seen.push(context);
        const payload = context.getPayload();
        return !(
          typeof payload === 'object' &&
          payload !== null &&
          Reflect.get(Reflect.get(payload, 'payload') ?? {}, 'blocked') === true
        );
      }
    }
    @Injectable()
    class Wrap implements NestInterceptor {
      async intercept(_context: PipelineContext, next: CallHandler): Promise<unknown> {
        return { wrapped: await next.handle() };
      }
    }
    @UseGuards(Observe)
    @Injectable()
    class GuardedHost {
      @UseInterceptors(Wrap)
      async run(event: WorkflowEvent<{ blocked: boolean }>): Promise<string> {
        return event.instanceId;
      }
    }
    @Module({ providers: [Observe, Wrap] })
    class AppModule {}
    const app = defineCloudflareApp(AppModule, { adapters: [reporting] });
    class Guarded extends VelaWorkflow(app, GuardedHost) {}
    const event: WorkflowEvent<{ blocked: boolean }> = {
      payload: { blocked: false },
      timestamp: new Date(0),
      instanceId: 'allowed',
      workflowName: 'guarded',
    };
    const workflow = new Guarded(platformContext(), {});
    expect(await workflow.run(event, engineStep())).toEqual({ wrapped: 'allowed' });
    const [context] = seen;
    expect(context?.getType()).toBe('cf:workflow');
    expect(context?.getClass()).toBe(GuardedHost);
    expect(context?.getHandlerName()).toBe('run');
    expect(context?.getPayload()).toBe(event);

    // A guard that denies fails the run: the platform sees the ForbiddenException.
    const denied = await rejection(
      workflow.run({ ...event, instanceId: 'blocked', payload: { blocked: true } }, engineStep()),
    );
    expect(denied).toBeInstanceOf(ForbiddenException);
  });

  it('reports a failure first and rethrows the same error for the engine', async () => {
    class NonRetryableError extends Error {
      override readonly name = 'NonRetryableError';
    }
    const failure = new NonRetryableError('card declined');
    @Catch(RangeError)
    class Recover implements ExceptionFilter {
      catch(): unknown {
        return { recovered: true };
      }
    }
    @Injectable()
    class FailingHost {
      constructor(@Inject(REPORTS) readonly reports: unknown[]) {}
      async run(event: WorkflowEvent<{ kind: string }>): Promise<unknown> {
        if (event.payload.kind === 'range') throw new RangeError('out of range');
        throw failure;
      }
    }
    @UseFilters(Recover)
    @Injectable()
    class RecoveringHost extends FailingHost {}
    @Module({})
    class AppModule {}
    const app = defineCloudflareApp(AppModule, { adapters: [reporting] });
    class Failing extends VelaWorkflow(app, FailingHost) {}
    class Recovering extends VelaWorkflow(app, RecoveringHost) {}
    const env = {};
    const event = (kind: string): WorkflowEvent<{ kind: string }> => ({
      payload: { kind },
      timestamp: new Date(0),
      instanceId: kind,
      workflowName: 'failing',
    });

    // Rethrown as it is, so the engine applies NonRetryableError and step semantics.
    expect(
      await rejection(new Failing(platformContext(), env).run(event('fatal'), engineStep())),
    ).toBe(failure);
    expect(await new Recovering(platformContext(), env).run(event('range'), engineStep())).toEqual({
      recovered: true,
    });
    const reports = (await reportsOf(app, env)).map(({ error, context }) => ({
      message: error instanceof Error ? error.message : String(error),
      context,
    }));
    expect(reports).toMatchObject([
      {
        message: 'card declined',
        context: { edge: 'workflow', source: 'FailingHost.run', kind: 'cf:workflow' },
      },
      {
        message: 'out of range',
        context: { edge: 'workflow', source: 'RecoveringHost.run', kind: 'cf:workflow' },
      },
    ]);
  });

  it('passes the engine aborts that pause or end a run through, unreported and unfiltered', async () => {
    const caught: unknown[] = [];
    @Catch()
    class CatchEverything implements ExceptionFilter {
      catch(error: unknown): string {
        caught.push(error);
        return 'swallowed';
      }
    }
    @UseFilters(CatchEverything)
    @Injectable()
    class NapHost {
      async run(_event: WorkflowEvent<{ nap: string }>, step: WorkflowStep): Promise<string> {
        await step.sleep('nap', '1 hour');
        return 'rested';
      }
    }
    @Module({})
    class AppModule {}
    const app = defineCloudflareApp(AppModule, { adapters: [reporting] });
    class Nap extends VelaWorkflow(app, NapHost) {}
    const env = {};
    const event: WorkflowEvent<{ nap: string }> = {
      payload: { nap: 'short' },
      timestamp: new Date(0),
      instanceId: 'nap',
      workflowName: 'naps',
    };
    /** A step whose sleep rejects with `error`, as the engine's does when it pauses the instance. */
    const interrupted = (error: unknown): WorkflowStep =>
      engineStep(async () => {
        throw error;
      });

    // The engine pauses, restarts or terminates an instance by throwing into
    // its run: the same error must reach it, or the run would complete.
    for (const reason of ['User called pause', 'User called restart', 'User called terminate']) {
      const abort = new Error(`Aborting engine: ${reason}`);
      // eslint-disable-next-line no-await-in-loop -- One run at a time.
      const error = await rejection(new Nap(platformContext(), env).run(event, interrupted(abort)));
      expect(error).toBe(abort);
    }
    expect(caught).toEqual([]);
    expect(await reportsOf(app, env)).toEqual([]);

    // A failure of the run itself is still reported and handed to the filter.
    const outage = new Error('clock unavailable');
    expect(await new Nap(platformContext(), env).run(event, interrupted(outage))).toBe('swallowed');
    expect(caught).toEqual([outage]);
    expect((await reportsOf(app, env)).map(({ error }) => error)).toEqual([outage]);
  });

  it('describes its classes for tools and validates its host when defined', () => {
    @Injectable()
    class ReportHost {
      async run(): Promise<void> {}
    }
    @Module({})
    class AppModule {}
    const app = defineCloudflareApp(AppModule);
    const Report = VelaWorkflow(app, ReportHost);
    class ExportedReport extends Report {}

    expect(Reflect.get(ExportedReport, CLOUDFLARE_WORKFLOW)).toEqual({
      rootModule: AppModule,
      host: ReportHost,
      workflow: Report,
    });
    expect(Report.name).toBe('ReportHostWorkflow');
    expect(app.workflows).toEqual([Reflect.get(Report, CLOUDFLARE_WORKFLOW)]);
    expect(app.worker[CLOUDFLARE_WORKER].workflows).toBe(app.workflows);

    class Thenable {
      async run(): Promise<void> {}
      then(): void {}
    }
    expect(() => VelaWorkflow(app, Thenable)).toThrow('Thenable defines then()');
    class Arrow {
      run = async (): Promise<void> => {};
    }
    expect(() => VelaWorkflow(app, Arrow)).toThrow('Arrow has no prototype method run');
    // @ts-expect-error a Workflow runs in the Worker application of an app definition
    expect(() => VelaWorkflow(AppModule, ReportHost)).toThrow('defineCloudflareApp');
  });

  it('adds its host to the Worker root, and refuses hosts once the Worker built it', async () => {
    @Injectable()
    class ReportHost {
      async run(): Promise<void> {}
    }
    @Injectable()
    class LateHost {
      async run(): Promise<void> {}
    }
    @Module({})
    class AppModule {}
    const app = defineCloudflareApp(AppModule);
    void VelaWorkflow(app, ReportHost);
    const application = await app.worker[CLOUDFLARE_WORKER].createApplication({});
    // Tools build the Worker root as the Worker does.
    expect(application.get(ReportHost)).toBeInstanceOf(ReportHost);
    await application.close();

    await app.worker.fetch(new Request('https://worker.test/'), {}, httpContext);
    expect(() => VelaWorkflow(app, LateHost)).toThrow('after the app started building');
  });
});
