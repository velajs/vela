import type { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { ENV, Inject, Injectable, ModuleRef, Scope, type Token, type VelaEnv } from '@velajs/vela';
import type { InferTokens } from '@velajs/vela/module-kit';
import {
  isValidationSchema,
  parseSchemaAsync,
  SchemaValidationError,
  type SchemaInput,
  type SchemaOutput,
  type ValidationSchema,
} from '@velajs/vela/validation';
import {
  convertNonRetryableError,
  createWorkflowRunContext,
  isWorkflowDefinition,
  type WorkflowDefinition,
  type WorkflowRunFunction,
} from '@velajs/workflow';
import type { CloudflareApp } from '../cloudflare-factory';
import { VelaWorkflow } from './vela-workflow';
import { portableWorkflowStep } from './portable-workflow-step';

function isEnvironment(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Dependencies of one portable run. Dispatch authority is supplied explicitly by the application. */
export interface WorkflowRuntime<Params, Output> {
  /** A definition may accept a wider input; its handler must accept every validated output. */
  readonly definition: Omit<WorkflowDefinition<Params, Output>, '__params'>;
  readonly run: WorkflowRunFunction;
}

export interface VelaWorkflowDefinitionOptions<
  S extends ValidationSchema,
  Inject extends readonly Token[],
  Output,
> {
  /** Validate native trigger data before resolving dependencies or calling the factory. */
  readonly params: S;
  readonly inject: Inject;
  /** Called once per native run, including replay, in that run's execution scope. */
  readonly useFactory: (
    ...dependencies: InferTokens<Inject>
  ) => WorkflowRuntime<SchemaOutput<S>, Output> | Promise<WorkflowRuntime<SchemaOutput<S>, Output>>;
}

/** Bindings take schema inputs; the portable definition receives schema outputs. */
export type VelaWorkflowDefinitionClass<Params, Output> = new (
  ctx: ExecutionContext,
  env: VelaEnv,
) => Omit<WorkflowEntrypoint<VelaEnv, Params>, 'run'> & {
  run(event: Readonly<WorkflowEvent<Params>>, step: WorkflowStep): Promise<Output>;
};

/**
 * Run a portable workflow or compiled agent through Vela's native Workflow host.
 * Export a named subclass and use that name in Wrangler's `class_name`.
 * The deployed `event.workflowName` labels logs; no export name or binding is inferred.
 */
export function VelaWorkflowDefinition<
  S extends ValidationSchema,
  const Inject extends readonly Token[],
  Output,
>(
  app: CloudflareApp,
  options: VelaWorkflowDefinitionOptions<S, Inject, Output>,
): VelaWorkflowDefinitionClass<SchemaInput<S>, Output> {
  if (!isValidationSchema(options.params))
    throw new TypeError('VelaWorkflowDefinition params requires a validation schema.');
  if (!Array.isArray(options.inject) || typeof options.useFactory !== 'function')
    throw new TypeError('VelaWorkflowDefinition requires inject and useFactory.');
  const { params: schema, useFactory } = options;
  const inject = [...options.inject];

  @Injectable({ scope: Scope.REQUEST })
  class PortableWorkflowHost {
    constructor(
      @Inject(ModuleRef) private readonly modules: ModuleRef,
      @Inject(ENV) private readonly env: VelaEnv,
    ) {}

    async run(
      event: Readonly<WorkflowEvent<SchemaOutput<S>>>,
      step: WorkflowStep,
    ): Promise<Output> {
      try {
        const env = this.env;
        if (!isEnvironment(env)) throw new TypeError('Workflow environment must be an object.');
        const resolved = await Promise.all(inject.map((token) => this.modules.resolve(token)));
        // Each position resolves its corresponding token; Promise.all erases the tuple mapping.
        const runtime = await useFactory(...(resolved as InferTokens<Inject>));
        if (
          !runtime ||
          !isWorkflowDefinition(runtime.definition) ||
          typeof runtime.definition.handler !== 'function' ||
          typeof runtime.run !== 'function'
        )
          throw new TypeError('Workflow factory must return { definition, run }.');
        return await runtime.definition.handler(
          createWorkflowRunContext({
            env,
            event,
            exportName: event.workflowName,
            run: runtime.run,
            step: portableWorkflowStep(step),
            nonRetryableErrorClass: NonRetryableError,
          }),
        );
      } catch (error) {
        return convertNonRetryableError(error, NonRetryableError);
      }
    }
  }

  const NativeWorkflow = VelaWorkflow(app, PortableWorkflowHost);
  // Validate before the native host boots the application. Bootstrap eagerly
  // creates singleton providers, which may themselves be factory dependencies.
  class ValidatedWorkflow extends NativeWorkflow {
    override async run(
      event: Readonly<WorkflowEvent<unknown>>,
      step: WorkflowStep,
    ): Promise<Awaited<Output>> {
      let params: SchemaOutput<S>;
      try {
        params = await parseSchemaAsync(schema, event.payload);
      } catch (error) {
        if (error instanceof SchemaValidationError)
          throw new NonRetryableError('Workflow trigger parameters failed validation.');
        return convertNonRetryableError(error, NonRetryableError);
      }
      return super.run({ ...event, payload: params }, step);
    }
  }
  return ValidatedWorkflow;
}
