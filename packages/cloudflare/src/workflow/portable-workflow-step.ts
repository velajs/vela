import type { WorkflowSleepDuration, WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import {
  convertNonRetryableError,
  type WorkflowStepConfigLike,
  type WorkflowStepContextLike,
  type WorkflowStepLike,
  type WorkflowStepRollbackOptionsLike,
} from '@velajs/workflow';

function duration(value: string | number): WorkflowSleepDuration {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (
    typeof value === 'string' &&
    /^\d+(?:\.\d+)? (?:second|minute|hour|day|week|month|year)s?$/.test(value)
  )
    return value as WorkflowSleepDuration;
  throw new NonRetryableError('Invalid Workflow duration.');
}

function config(value: WorkflowStepConfigLike): WorkflowStepConfigLike & WorkflowStepConfig {
  if (value.retries && (!Number.isInteger(value.retries.limit) || value.retries.limit < 0))
    throw new NonRetryableError('Workflow retries.limit must be a nonnegative integer.');
  return {
    ...(value.timeout !== undefined ? { timeout: duration(value.timeout) } : {}),
    ...(value.retries
      ? {
          retries: {
            ...value.retries,
            // Cloudflare's default delay is ten seconds. The portable contract permits omission.
            delay: duration(value.retries.delay ?? 10_000),
          },
        }
      : {}),
  };
}

/** Translate at callback boundaries, before the engine decides whether a failure should retry. */
export function portableWorkflowStep(native: WorkflowStep): WorkflowStepLike {
  // Portable result types are unconstrained. Native checkpoint serialization remains
  // authoritative and rejects unsupported values; only this call boundary erases that constraint.
  async function run<T>(
    name: string,
    second: WorkflowStepConfigLike | ((context: WorkflowStepContextLike) => Promise<T>),
    third?: ((context: WorkflowStepContextLike) => Promise<T>) | WorkflowStepRollbackOptionsLike<T>,
    fourth?: WorkflowStepRollbackOptionsLike<T>,
  ): Promise<T> {
    const callback = typeof second === 'function' ? second : third;
    if (typeof callback !== 'function')
      throw new TypeError('Workflow step.do requires a callback.');
    const declaredRollback = typeof second === 'function' ? third : fourth;
    const rollback = typeof declaredRollback === 'object' ? declaredRollback : undefined;
    const forward = async (context: WorkflowStepContextLike): Promise<T> => {
      try {
        // The engine validates checkpoint serialization and rejects unsupported results.
        return await callback(context);
      } catch (error) {
        return convertNonRetryableError(error, NonRetryableError);
      }
    };
    let rollbackOptions: WorkflowStepRollbackOptionsLike<T> | undefined;
    if (rollback?.rollback) {
      const undo = rollback.rollback;
      rollbackOptions = {
        rollback: async (context) => {
          try {
            await undo(context);
          } catch (error) {
            convertNonRetryableError(error, NonRetryableError);
          }
        },
        ...(rollback.rollbackConfig ? { rollbackConfig: config(rollback.rollbackConfig) } : {}),
      };
    } else if (rollback?.rollbackConfig) {
      throw new NonRetryableError('Workflow rollbackConfig requires a rollback handler.');
    }
    return typeof second === 'function'
      ? (native.do as WorkflowStepLike['do'])(name, forward, rollbackOptions)
      : (native.do as WorkflowStepLike['do'])(name, config(second), forward, rollbackOptions);
  }

  return {
    do: run,
    sleep: (name, value) => native.sleep(name, duration(value)),
    sleepUntil: (name, timestamp) => native.sleepUntil(name, timestamp),
    waitForEvent: (name, options) =>
      native.waitForEvent(name, {
        type: options.type,
        ...(options.timeout !== undefined ? { timeout: duration(options.timeout) } : {}),
      }),
  };
}
