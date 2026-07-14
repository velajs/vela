import { WorkflowEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import {
  convertNonRetryableError,
  createWorkflowRunContext,
  workflowClassName,
} from '@velajs/workflow';
import type {
  NativeNonRetryableErrorConstructor,
  WorkflowDefinition,
  WorkflowEventLike,
  WorkflowRunFunction,
  WorkflowStepLike,
} from '@velajs/workflow';
import type { Type } from '@velajs/vela';
import {
  buildWorkflowRuntime,
  DEFAULT_WORKFLOW_SERVICE_BINDING,
  type WorkflowRuntime,
} from './build-workflow-runtime';
import type { AnyWorkflowDefinition } from './tokens';

/** The entrypoint isolate's `env` shape (opaque binding record). */
type WorkflowEnv = Record<string, unknown>;

/**
 * The construct signature the platform instantiates. The exported const's NAME
 * must equal `workflowClassName(exportName)` so it matches wrangler's
 * `workflows[].class_name`; `createWorkflowEntrypoints` guarantees this by keying
 * the returned object off the same pure derivation.
 */
export type WorkflowEntrypointClass = new (
  ctx: ExecutionContext,
  env: WorkflowEnv,
) => WorkflowEntrypoint<WorkflowEnv>;

/** Inputs for {@link runWorkflowDefinition} — the neutral, castless run seam. */
export interface RunWorkflowDefinitionArgs<Params> {
  env: Record<string, unknown>;
  event: WorkflowEventLike<Params>;
  /** The workflow export name — run-context/log correlation. */
  exportName: string;
  /** The `ctx.run` seam (cross-isolate signed dispatch on the platform). */
  run: WorkflowRunFunction;
  /** The durable-step API (native `WorkflowStep` on the platform, a fake in tests). */
  step: WorkflowStepLike;
  /** The native `NonRetryableError` used for the top-level terminal-error translation. */
  nonRetryableErrorClass: NativeNonRetryableErrorConstructor;
}

/**
 * Run one workflow definition's handler against a run context assembled from the
 * neutral `@velajs/workflow` inputs, then translate a top-level portable
 * `WorkflowNonRetryableError` into the native class. This is the exact body the
 * generated entrypoint's `run` executes, factored out so it can be driven with
 * the package's structural doubles (the replay harness) without any platform
 * types — which is why the entrypoint class stays a thin shell over it.
 */
export const runWorkflowDefinition = async <Params = Record<string, unknown>, Output = unknown>(
  definition: WorkflowDefinition<Params, Output>,
  args: RunWorkflowDefinitionArgs<Params>,
): Promise<Output> => {
  const context = createWorkflowRunContext<Params>({
    env: args.env,
    event: args.event,
    exportName: args.exportName,
    run: args.run,
    // Identity mapping — the native CF `step` is used verbatim as WorkflowStepLike.
    step: args.step,
    nonRetryableErrorClass: args.nonRetryableErrorClass,
  });

  try {
    return await definition.handler(context);
  } catch (error: unknown) {
    // A terminal failure thrown at the top level (outside any step.do): make it
    // the native NonRetryableError so workerd abandons the instance immediately.
    // Inside steps, createRunStep already does this translation.
    return convertNonRetryableError(error, args.nonRetryableErrorClass);
  }
};

/** Options for {@link createWorkflowEntrypoint}. */
export interface CreateWorkflowEntrypointOptions {
  /** The app's root module — booted in this isolate to resolve `ctx.run` targets. */
  rootModule: Type;
  /** The workflow's export name — drives run-context/log correlation. */
  name: string;
  /**
   * Self-service binding used for cross-isolate `ctx.run` re-entry. Defaults to
   * `SELF`; must be declared in wrangler as
   * `services: [{ binding: 'SELF', service: '<this-worker>' }]`.
   */
  serviceBinding?: string;
}

/**
 * Build the `WorkflowEntrypoint` subclass the Cloudflare platform runs for one
 * declared workflow. Mirrors `VelaWebSocketDurableObject(rootModule)`: the app's
 * entry re-exports the returned class under a const whose name equals
 * `workflows[].class_name`.
 *
 * ```ts
 * export const OrderPipelineWorkflow = createWorkflowEntrypoint(orderPipeline, {
 *   rootModule: AppModule,
 *   name: 'orderPipeline',
 * });
 * ```
 *
 * `run` lazily builds and memoizes the entrypoint runtime (a single in-flight
 * promise serializes concurrent invocations), then delegates to
 * {@link runWorkflowDefinition}. The native `event`/`step` are handed across the
 * native → neutral seam the same way the WebSocket DO shell crosses it
 * (`as unknown as WsLike`): at runtime the CF objects satisfy the structural
 * `*Like` shapes verbatim; the two only diverge at the type level (rollback
 * optionality, `waitForEvent`'s extra return fields), both runtime-safe.
 */
export const createWorkflowEntrypoint = <Params = Record<string, unknown>, Output = unknown>(
  definition: WorkflowDefinition<Params, Output>,
  options: CreateWorkflowEntrypointOptions,
): WorkflowEntrypointClass => {
  const serviceBinding = options.serviceBinding ?? DEFAULT_WORKFLOW_SERVICE_BINDING;

  return class VelaWorkflowEntrypoint extends WorkflowEntrypoint<WorkflowEnv> {
    private runtime: Promise<WorkflowRuntime> | undefined;

    /** Build the runtime once; the memoized promise serializes concurrent run()s. */
    private ready(): Promise<WorkflowRuntime> {
      this.runtime ??= buildWorkflowRuntime({
        rootModule: options.rootModule,
        env: this.env,
        serviceBinding,
        nonRetryableErrorClass: NonRetryableError,
      });
      return this.runtime;
    }

    // Derive the exact native param types from the base `run` so the override is
    // signature-identical (no need to name the `cloudflare:workers` types, which
    // are not exposed as globals): `event` is `Readonly<WorkflowEvent<unknown>>`,
    // `step` is the native `WorkflowStep`.
    override async run(
      event: Parameters<WorkflowEntrypoint<WorkflowEnv>['run']>[0],
      step: Parameters<WorkflowEntrypoint<WorkflowEnv>['run']>[1],
    ): Promise<Output> {
      const runtime = await this.ready();
      return runWorkflowDefinition(definition, {
        env: this.env,
        event: event as unknown as WorkflowEventLike<Params>,
        exportName: options.name,
        run: runtime.run,
        step: step as unknown as WorkflowStepLike,
        nonRetryableErrorClass: NonRetryableError,
      });
    }
  };
};

/** Options for {@link createWorkflowEntrypoints}. */
export interface CreateWorkflowEntrypointsOptions {
  /** The app's root module. */
  rootModule: Type;
  /** Self-service binding for cross-isolate re-entry (default `SELF`), applied to all. */
  serviceBinding?: string;
}

/**
 * Build every workflow's entrypoint class in one call, keyed by
 * `workflowClassName(exportName)` so a single destructuring re-exports them all
 * with the exact const names wrangler expects:
 *
 * ```ts
 * import * as workflows from './workflows';
 * export const { OrderPipelineWorkflow } = createWorkflowEntrypoints(workflows, {
 *   rootModule: AppModule,
 * });
 * ```
 */
export const createWorkflowEntrypoints = (
  workflows: Record<string, AnyWorkflowDefinition>,
  options: CreateWorkflowEntrypointsOptions,
): Record<string, WorkflowEntrypointClass> => {
  const classes: Record<string, WorkflowEntrypointClass> = {};

  for (const [exportName, definition] of Object.entries(workflows)) {
    classes[workflowClassName(exportName)] = createWorkflowEntrypoint(definition, {
      rootModule: options.rootModule,
      name: exportName,
      ...(options.serviceBinding !== undefined ? { serviceBinding: options.serviceBinding } : {}),
    });
  }

  return classes;
};
