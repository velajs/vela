import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Type, VelaEnv } from '@velajs/vela';
import type { EntrypointExecutionContext } from '@velajs/vela/module-kit';
import type { CloudflareApplication } from '../cloudflare-application';
import {
  CLOUDFLARE_WORKFLOW,
  cloudflareApplication,
  isCloudflareApp,
  registerWorkflow,
  type CloudflareApp,
  type CloudflareWorkflowDescriptor,
} from '../cloudflare-factory';
import { HostInvoker, hostModuleId, platformSettlement } from '../host/host-invoker';
import { assertNotThenable, hasPrototypeMethod } from '../host/host-members';

/**
 * A class `VelaWorkflow()` runs: an `@Injectable()` whose
 * `run(event, step)` is the Workflow's body, typed with the params in
 * `event.payload`.
 */
export interface WorkflowHost {
  run(event: never, step: never): unknown;
}

/**
 * The params a Workflow takes: the `event.payload` type of its host's
 * `run(event, step)`, or of the `run` of a class from `VelaWorkflow()`.
 * `workflow<WorkflowParams<SignupWorkflow>>({ binding })` types the binding
 * that creates its instances.
 */
export type WorkflowParams<Target> = Target extends abstract new (
  ...args: never[]
) => infer Instance
  ? WorkflowParams<Instance>
  : Target extends { run(event: infer Event, ...rest: never[]): unknown }
    ? Event extends { readonly payload: infer Payload }
      ? Payload
      : unknown
    : never;

/** What a Workflow host's `run(event, step)` resolves to: the instance's output. */
export type WorkflowOutput<Host extends WorkflowHost> = Awaited<ReturnType<Host['run']>>;

/** The ExecutionContext guards, interceptors and filters receive around a Workflow run. */
export type WorkflowExecutionContext = EntrypointExecutionContext<'cf:workflow'>;

/**
 * The class `VelaWorkflow(app, Host)` returns: export a named subclass of it,
 * matching the Wrangler `workflows` entry's `class_name`. It also carries its
 * `CloudflareWorkflowDescriptor` under the static `CLOUDFLARE_WORKFLOW` key,
 * for tools.
 */
export type VelaWorkflowClass<Host extends WorkflowHost> = new (
  ctx: ExecutionContext,
  env: VelaEnv,
) => {
  // First, so a call resolves to the host's output rather than the base class's unknown.
  run(
    event: Readonly<WorkflowEvent<WorkflowParams<Host>>>,
    step: WorkflowStep,
  ): Promise<WorkflowOutput<Host>>;
} & WorkflowEntrypoint<VelaEnv, WorkflowParams<Host>>;

// A filter that catches a failure settles the run with what it returns;
// managed work that fails after a successful run is reported, never retried.
const workflowSettlement = platformSettlement(false);

/**
 * A Workflow class (a `WorkflowEntrypoint`) whose `run(event, step)` is the
 * `run` method of `host`, an `@Injectable()` class, resolved in the Worker's
 * application for the run's environment: the same application the app's
 * Worker handlers use. The host is added to the root module's providers, so
 * it injects `ENV` and what the root module can see. Export a named subclass
 * matching the Wrangler `class_name`:
 *
 * ```ts
 * @Injectable()
 * export class SignupWorkflowHost {
 *   constructor(private readonly users: UsersService) {}
 *
 *   async run(event: WorkflowEvent<{ email: string }>, step: WorkflowStep) {
 *     const user = await step.do('create user', () => this.users.create(event.payload.email));
 *     await step.sleep('grace period', '1 day');
 *     return step.do('send welcome', () => this.users.welcome(user.id));
 *   }
 * }
 * export class SignupWorkflow extends VelaWorkflow(app, SignupWorkflowHost) {}
 * // Worker code: await env.SIGNUP_WORKFLOW.create({ params: { email } })
 * ```
 *
 * - Each run executes in its own execution scope, so request-scoped providers
 *   are built per run, through the host's scoped guards, interceptors and
 *   exception filters (`getType()` is `'cf:workflow'`, `getPayload()` the
 *   event). The engine may run `run()` again for the same instance (after a
 *   sleep, an event or an eviction), replaying completed steps from their
 *   stored results: each call is a new run.
 * - `event` and `step` are the platform's own objects, passed through
 *   untouched, so `step.do`, `step.sleep` and `step.waitForEvent` keep their
 *   retry and replay semantics.
 * - A failure is reported (`edge: 'workflow'`) and rethrown as it is, so the
 *   engine applies its own semantics, including `NonRetryableError`. A scoped
 *   exception filter that catches it settles the run with what it returns.
 * - `host` must declare `run` on its prototype; a host whose prototype
 *   defines `then()` is rejected, since an instance would be a thenable.
 */
export function VelaWorkflow<Host extends WorkflowHost>(
  app: CloudflareApp,
  host: Type<Host>,
): VelaWorkflowClass<Host> {
  if (!isCloudflareApp(app)) {
    throw new TypeError(
      'VelaWorkflow() takes the app from defineCloudflareApp(AppModule, options): each run ' +
        'executes in the Worker application that app builds.',
    );
  }
  if (typeof host !== 'function') {
    throw new TypeError('VelaWorkflow(app, Host) takes the @Injectable() host class.');
  }
  assertNotThenable(host);
  if (!hasPrototypeMethod(host, 'run')) {
    throw new TypeError(
      `${host.name} has no prototype method run(event, step): declare run in the class body ` +
        'as the Workflow body, not as an accessor or an instance field.',
    );
  }
  const rootClass = typeof app.rootModule === 'function' ? app.rootModule : app.rootModule.module;
  const invokers = new WeakMap<CloudflareApplication, HostInvoker>();
  const invokerOf = (application: CloudflareApplication): HostInvoker => {
    const existing = invokers.get(application);
    if (existing) return existing;
    const container = application.getContainer();
    const invoker = new HostInvoker({
      container,
      host,
      moduleId: hostModuleId(container, host, rootClass),
      edge: 'workflow',
    });
    invokers.set(application, invoker);
    return invoker;
  };

  class VelaHostWorkflow extends WorkflowEntrypoint<VelaEnv, WorkflowParams<Host>> {
    override async run(
      event: Readonly<WorkflowEvent<WorkflowParams<Host>>>,
      step: WorkflowStep,
    ): Promise<unknown> {
      const application = await cloudflareApplication(app, this.env);
      return invokerOf(application).invoke({
        kind: 'cf:workflow',
        method: 'run',
        args: [event, step],
        payload: event,
        settlement: workflowSettlement,
      });
    }
  }

  const descriptor: CloudflareWorkflowDescriptor = {
    rootModule: app.rootModule,
    host,
    workflow: VelaHostWorkflow,
  };
  registerWorkflow(app, descriptor);
  Object.defineProperty(VelaHostWorkflow, 'name', { value: `${host.name}Workflow` });
  Object.defineProperty(VelaHostWorkflow, CLOUDFLARE_WORKFLOW, { value: descriptor });
  // `run` resolves to the host's output; the class type says so for bindings and tests.
  return VelaHostWorkflow as unknown as VelaWorkflowClass<Host>;
}
