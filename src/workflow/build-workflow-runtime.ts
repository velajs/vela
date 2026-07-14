import {
  InternalDispatcher,
  isVelaError,
  VelaError,
  VelaFactory,
  type RuntimeAdapter,
  type Type,
} from '@velajs/vela';
import type {
  NativeNonRetryableErrorConstructor,
  WorkflowRunFunction,
  WorkflowRunInit,
  WorkflowRunTarget,
} from '@velajs/workflow';
import { BindingRef } from '../binding-ref';
import { EnvRef } from '../env-ref';
import { WorkflowsService } from './workflows.service';

/** Default self-service binding name used for cross-isolate `ctx.run` re-entry. */
export const DEFAULT_WORKFLOW_SERVICE_BINDING = 'SELF';

/** The subset of a Cloudflare service binding (`Fetcher`) the transport consumes. */
interface FetcherLike {
  fetch(request: Request): Promise<Response>;
}

const isFetcher = (value: unknown): value is FetcherLike =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { fetch?: unknown }).fetch === 'function';

/** Options for {@link buildWorkflowRuntime}. */
export interface BuildWorkflowRuntimeOptions {
  /** The app's root module — the same one the main Worker boots from. */
  rootModule: Type;
  /** The Workflow entrypoint isolate's `env`. */
  env: Record<string, unknown>;
  /** The self-service binding name to re-enter through (default `SELF`). */
  serviceBinding: string;
  /** The platform's native `NonRetryableError`, for the deterministic-4xx mapping. */
  nonRetryableErrorClass: NativeNonRetryableErrorConstructor;
}

/** The per-entrypoint runtime {@link buildWorkflowRuntime} produces. */
export interface WorkflowRuntime {
  /**
   * The `ctx.run` seam handed to the workflow context: a cross-isolate signed
   * dispatch that additionally maps a deterministic 4xx into the native
   * `NonRetryableError` (5xx stays retryable).
   */
  run: WorkflowRunFunction;
  /** The `ctx.workflows` producer, when `WorkflowModule` is imported. */
  workflows: WorkflowsService | undefined;
  /** Run shutdown lifecycle hooks over the isolate's app. */
  close(signal?: string): Promise<void>;
}

/**
 * The `RuntimeAdapter` that turns a plain app into a Workflow-entrypoint-isolate
 * app. It does the two things a Workflow isolate needs that a normal Worker
 * isolate gets for free:
 *
 * 1. **Binding init from `env`** — the entrypoint never serves an HTTP request,
 *    so `cloudflareAdapter`'s request-middleware binding-init never fires. This
 *    initializes every `BindingRef`/`EnvRef` straight from `env` at bootstrap
 *    (the `buildDoRuntime` pattern), so eager local binding use works.
 * 2. **The cross-isolate `ctx.run` transport** — the routes live in the MAIN
 *    Worker, so re-entry must cross back over a self-service binding. Returns a
 *    transport that simply fetches the (signed) request over `env[serviceBinding]`.
 *    FAILS CLOSED when that binding is absent: never fall back to the in-isolate
 *    `app.fetch` default, which would 404 every `ctx.run` (the routes are not in
 *    this isolate). Signing/verification are byte-identical to the in-isolate
 *    path — only the network hop differs.
 */
export const workflowReentryAdapter = (options: {
  env: Record<string, unknown>;
  serviceBinding: string;
}): RuntimeAdapter => {
  const { env, serviceBinding } = options;
  return {
    name: 'cloudflare-workflow-reentry',
    onBootstrap: ({ container }) => {
      // Enumerate per-instance useValue providers across ALL module buckets: two
      // same-type binding modules share one token but live in distinct buckets,
      // so resolving the token would return only the first and leave the rest
      // uninitialized (mirrors cloudflareAdapter + buildDoRuntime exactly).
      for (const value of container.getUseValues()) {
        if (value instanceof EnvRef) value._initialize(env);
        else if (value instanceof BindingRef) value._initialize(env[value.bindingName]);
      }
    },
    invocationTransport: () => {
      const binding = env[serviceBinding];
      if (!isFetcher(binding)) {
        throw new VelaError('internal', {
          message:
            `Workflow re-entry service binding '${serviceBinding}' is missing from env — ` +
            `add a self-service binding in wrangler ` +
            `(services: [{ binding: '${serviceBinding}', service: '<this-worker>' }]).`,
        });
      }
      return (request: Request): Promise<Response> => binding.fetch(request);
    },
  };
};

/**
 * Build the DI runtime for a Workflow entrypoint isolate. Uses `VelaFactory.create`
 * with {@link workflowReentryAdapter} so, in one pass, it: boots the module graph,
 * runs lifecycle hooks (which build `app.entrypoints`, including the `cf:workflow`
 * kind), initializes bindings from `env`, builds the named-route table (so
 * `urlFor` can resolve `{ route }` targets), and registers the cross-isolate
 * transport as the sole `INVOCATION_TRANSPORT` — the adapter's
 * `invocationTransport` hook wins over core's default `app.fetch` short-circuit.
 *
 * The returned `run` wraps `InternalDispatcher.run` with the `ctx.run`
 * non-retryable mapping: a caught `VelaError` with a deterministic 4xx status is
 * re-thrown as the native `NonRetryableError` so a bad input never drains the
 * retry budget; a 5xx propagates unchanged (retryable).
 *
 * @throws `VelaError('internal', …)` when the self-service binding is absent from
 *   `env` (fail-closed, from {@link workflowReentryAdapter}).
 */
export const buildWorkflowRuntime = async (
  options: BuildWorkflowRuntimeOptions,
): Promise<WorkflowRuntime> => {
  const { rootModule, env, serviceBinding, nonRetryableErrorClass } = options;

  const app = await VelaFactory.create(rootModule, {
    adapters: [workflowReentryAdapter({ env, serviceBinding })],
  });

  const container = app.getContainer();
  const dispatcher = container.resolve(InternalDispatcher);

  // ctx.workflows is optional here — the module may not be imported, and it is
  // module-scoped rather than global, so resolution can legitimately fail.
  let workflows: WorkflowsService | undefined;
  try {
    workflows = container.resolve(WorkflowsService);
  } catch {
    workflows = undefined;
  }

  const run: WorkflowRunFunction = async <Result = unknown>(
    target: WorkflowRunTarget,
    init?: WorkflowRunInit,
  ): Promise<Result> => {
    try {
      return await dispatcher.run<Result>(target, init);
    } catch (error: unknown) {
      // Deterministic 4xx ⇒ terminal: a bad input will fail identically on every
      // retry, so escalate to the platform's non-retryable error. 5xx (transient)
      // propagates as the retryable VelaError.
      if (isVelaError(error) && error.status >= 400 && error.status < 500) {
        throw new nonRetryableErrorClass(error.message);
      }
      throw error;
    }
  };

  return {
    run,
    workflows,
    close: (signal?: string): Promise<void> => app.close(signal),
  };
};
