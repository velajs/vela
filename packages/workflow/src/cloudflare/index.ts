import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { convertNonRetryableError } from '../errors';
import { createWorkflowRunContext } from '../run-context';
import type {
  WorkflowDefinition,
  WorkflowRunFunction,
  WorkflowStepConfigLike,
  WorkflowStepContextLike,
  WorkflowStepLike,
  WorkflowStepRollbackOptionsLike,
} from '../types';

export interface CloudflareWorkflowRunOptions<Params> {
  /** Validate the actual native payload before assigning the definition's parameter type. */
  schema: StandardSchemaV1<unknown, Params>;
  event: Readonly<WorkflowEvent<unknown>>;
  env: Record<string, unknown>;
  step: WorkflowStep;
  /** Inject an authenticated dispatcher from this invocation's application/environment. */
  run: WorkflowRunFunction;
}

/** Adapt error boundaries only. Native Workflows owns persistence, retries and replay.
 * Portable step values/configuration remain subject to native serialization and limits.
 * Native-only features (dynamic retry delays, sensitive/stream outputs) use the host's
 * original WorkflowStep instead of the portable contract. */
function portableStep(native: WorkflowStep): WorkflowStepLike {
  // The portable contract deliberately accepts broader durations and results. The
  // engine validates these at runtime; no result is parsed or reserialized here.
  const step = native as unknown as WorkflowStepLike;
  async function perform<T>(
    name: string,
    configOrCallback: WorkflowStepConfigLike | ((context: WorkflowStepContextLike) => Promise<T>),
    callbackOrRollback?:
      | ((context: WorkflowStepContextLike) => Promise<T>)
      | WorkflowStepRollbackOptionsLike<T>,
    rollback?: WorkflowStepRollbackOptionsLike<T>,
  ): Promise<T> {
    const config = typeof configOrCallback === 'function' ? undefined : configOrCallback;
    const callback = typeof configOrCallback === 'function' ? configOrCallback : callbackOrRollback;
    if (typeof callback !== 'function') throw new TypeError('step.do requires a callback');
    const options =
      typeof configOrCallback === 'function'
        ? (callbackOrRollback as WorkflowStepRollbackOptionsLike<T> | undefined)
        : rollback;
    const execute = async (context: WorkflowStepContextLike): Promise<T> => {
      try {
        return await callback(context);
      } catch (error) {
        return convertNonRetryableError(error, NonRetryableError);
      }
    };
    const compensate = options?.rollback;
    const wrapped =
      options === undefined
        ? undefined
        : {
            ...options,
            ...(compensate
              ? {
                  rollback: async (context: Parameters<typeof compensate>[0]) => {
                    try {
                      await compensate(context);
                    } catch (error) {
                      convertNonRetryableError(error, NonRetryableError);
                    }
                  },
                }
              : {}),
          };
    return config === undefined
      ? step.do(name, execute, wrapped)
      : step.do(name, config, execute, wrapped);
  }
  return {
    do: perform,
    sleep: (name, duration) => step.sleep(name, duration),
    sleepUntil: (name, timestamp) => step.sleepUntil(name, timestamp),
    waitForEvent: (name, options) => step.waitForEvent(name, options),
  };
}

/** Call from an existing VelaWorkflow host or native WorkflowEntrypoint.run.
 * No environment, dispatcher, context, or step results are cached by this adapter.
 * Schema validators must be deterministic across replays. Event payloads remain
 * unknown until the workflow validates them. Effects belong inside native steps. */
export async function runCloudflareWorkflow<Params, Output>(
  definition: WorkflowDefinition<Params, Output>,
  options: CloudflareWorkflowRunOptions<NoInfer<Params>>,
): Promise<Output> {
  try {
    const result = await options.schema['~standard'].validate(options.event.payload);
    if (result.issues) throw new NonRetryableError('Invalid workflow payload');
    return await definition.handler(
      createWorkflowRunContext({
        env: options.env,
        event: { ...options.event, payload: result.value },
        exportName: definition.name ?? options.event.workflowName,
        run: options.run,
        step: portableStep(options.step),
        nonRetryableErrorClass: NonRetryableError,
      }),
    );
  } catch (error) {
    return convertNonRetryableError(error, NonRetryableError);
  }
}

export { workflowEventStream } from './subscription';
export type { WorkflowEventStreamOptions } from './subscription';
