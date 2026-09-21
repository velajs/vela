/**
 * `createRunStep` produces the `ctx.runStep` helper that promotes a
 * {@link StepDefinition} into a durable `step.do` call. Nothing here reaches into
 * `cloudflare:workers`: the native step object and the native non-retryable
 * constructor are handed in by the caller, so every stage — checking the args,
 * running the body, checking the result, wiring the rollback, and translating the
 * terminal error — can be driven with ordinary in-memory doubles.
 *
 * Validation touches zod only through the `.safeParse` method of whatever schema
 * the author supplied; no `z.*` value is referenced, so zod stays a types-only
 * peer that contributes nothing to the bundle.
 */
import { convertNonRetryableError, WorkflowNonRetryableError } from './errors';
import type { NativeNonRetryableErrorConstructor } from './errors';
import type {
  InferStepArgs,
  InferStepInput,
  RunStepOptions,
  StepArgsShape,
  StepDefinition,
  StepRunContext,
  WorkflowLogger,
  WorkflowRollbackContextLike,
  WorkflowRunFunction,
  WorkflowStepContextLike,
  WorkflowStepLike,
  WorkflowStepRollbackOptionsLike,
} from './types';

/**
 * Check a step's args key-by-key against their schemas, throwing on the first
 * rejection with a `step args.<key>` prefix that names the offending field. This
 * runs up front, before the durable step begins: the args stay fixed for the life
 * of the instance, so a schema mismatch is a deterministic authoring bug best
 * surfaced immediately instead of from inside a step that would otherwise retry.
 */
export const validateStepArgs = <A extends StepArgsShape>(
  argsShape: A,
  source: unknown,
): InferStepArgs<A> => {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new WorkflowNonRetryableError('step args: expected an object');
  }
  const supplied = source as Record<string, unknown>;
  const accepted: Record<string, unknown> = {};

  for (const [key, schema] of Object.entries(argsShape)) {
    const outcome = schema.safeParse(Object.hasOwn(supplied, key) ? supplied[key] : undefined);

    if (!outcome.success) {
      const reason = outcome.error.issues[0]?.message ?? 'invalid';
      throw new WorkflowNonRetryableError(`step args.${key}: ${reason}`);
    }

    Object.defineProperty(accepted, key, {
      value: outcome.data,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return accepted as InferStepArgs<A>;
};

/** What {@link createRunStep} needs: the native step object plus the run's env, dispatcher, and logger. */
export interface RunStepDeps {
  env: Record<string, unknown>;
  log: WorkflowLogger;
  run: WorkflowRunFunction;
  step: WorkflowStepLike;
  /** Optional error constructor supplied by an execution adapter. */
  nonRetryableErrorClass?: NativeNonRetryableErrorConstructor;
}

/**
 * Build the `ctx.runStep` function scoped to one workflow invocation. Each call
 * drives its step through `step.do(...)`: check the args, run the body, then check
 * the result whenever a `returns` schema is present. A `returns` mismatch is
 * reproducible — the same body output would fail again on every attempt — so it is
 * escalated to a non-retryable failure, letting the instance stop fast rather than
 * drain its retry budget. Any declared rollback is passed through to the native
 * step.
 */
export const createRunStep =
  (
    deps: RunStepDeps,
  ): (<A extends StepArgsShape, Result>(
    step: StepDefinition<A, Result>,
    args: InferStepInput<A>,
    options?: RunStepOptions,
  ) => Promise<Result>) =>
  async <A extends StepArgsShape, Result>(
    step: StepDefinition<A, Result>,
    args: InferStepInput<A>,
    options?: RunStepOptions,
  ): Promise<Result> => {
    const config = options?.config ?? step.config;

    // Check once and hold the result: the body and the rollback (which the
    // platform may replay on its own) then read the same accepted object, so there
    // is exactly one validation site and the two paths cannot disagree.
    let checkedArgs: InferStepArgs<A>;
    try {
      checkedArgs = validateStepArgs(step.args, args);
    } catch (error: unknown) {
      return convertNonRetryableError(error, deps.nonRetryableErrorClass);
    }
    const name = options?.name ?? step.name;
    if (!name.trim()) throw new WorkflowNonRetryableError('step name must not be empty');

    const callback = async (native: WorkflowStepContextLike): Promise<Result> => {
      const stepContext: StepRunContext = {
        attempt: native.attempt,
        config: native.config,
        env: deps.env,
        log: deps.log,
        run: deps.run,
        step: native.step,
      };

      let output: unknown;

      try {
        output = await step.handler(stepContext, checkedArgs);
      } catch (thrown: unknown) {
        // A body that throws may have hit something transient (a flaky call, a
        // write contention), so it remains eligible for retry: only a portable
        // non-retryable is translated here; anything else is re-thrown verbatim.
        return convertNonRetryableError(thrown, deps.nonRetryableErrorClass);
      }

      if (!step.returns) {
        // defineStep infers Result from the handler when no returns schema is supplied.
        return output as Result;
      }

      const checked = step.returns.safeParse(output);

      if (checked.success) {
        return checked.data;
      }

      const reason = checked.error.issues[0]?.message ?? 'invalid';
      const terminal = new WorkflowNonRetryableError(
        `output of step "${step.name}" does not match its returns schema: ${reason}`,
      );

      return convertNonRetryableError(terminal, deps.nonRetryableErrorClass);
    };

    const userRollback = step.rollback;
    const nativeRollback: WorkflowStepRollbackOptionsLike<Result> | undefined = userRollback
      ? {
          rollback: async (undoContext: WorkflowRollbackContextLike<Result>): Promise<void> => {
            await userRollback({
              args: checkedArgs,
              env: deps.env,
              error: undoContext.error,
              log: deps.log,
              output: undoContext.output,
              run: deps.run,
            });
          },
          // Forward the optional rollback config only when the step actually set it.
          ...(step.rollbackConfig !== undefined ? { rollbackConfig: step.rollbackConfig } : {}),
        }
      : undefined;

    return config === undefined
      ? deps.step.do(name, callback, nativeRollback)
      : deps.step.do(name, config, callback, nativeRollback);
  };
