/**
 * Shared test doubles. `immediateStep` is a non-durable {@link WorkflowStepLike}
 * that runs every `step.do` callback eagerly (no memoization) — ideal for
 * exercising the run-step validation path in isolation. The replay/memoization
 * behavior itself is proven separately by the harness acceptance tests.
 */
import type {
  WorkflowRunFunction,
  WorkflowRunInit,
  WorkflowRunTarget,
  WorkflowStepConfigLike,
  WorkflowStepContextLike,
  WorkflowStepLike,
} from '../types';

/** A step double that invokes each `do` callback immediately and returns its result. */
export const immediateStep = (): WorkflowStepLike => ({
  do: <T>(
    name: string,
    a: WorkflowStepConfigLike | ((context: WorkflowStepContextLike) => Promise<T>),
    b?: unknown,
    _c?: unknown,
  ): Promise<T> => {
    const callback = (typeof a === 'function' ? a : b) as (
      context: WorkflowStepContextLike,
    ) => Promise<T>;
    const config: WorkflowStepConfigLike = typeof a === 'function' ? {} : a;

    return callback({ attempt: 1, config, step: { name, count: 1 } });
  },
  sleep: async (): Promise<void> => {},
  sleepUntil: async (): Promise<void> => {},
  waitForEvent: () => Promise.reject(new Error('immediateStep: waitForEvent is not supported')),
});

/** A `ctx.run` double that rejects if called. */
export const rejectingRun: WorkflowRunFunction = async () => {
  throw new Error('run should not have been called');
};

/** A recorded `ctx.run` call. */
export interface RunCall {
  target: WorkflowRunTarget;
  init: WorkflowRunInit | undefined;
}

/**
 * A `ctx.run` double that records each call and then rejects — enough to assert
 * the seam is wired and forwards the exact target/init, without needing to
 * configure an external result.
 */
export const recordingRun = (): { run: WorkflowRunFunction; calls: RunCall[] } => {
  const calls: RunCall[] = [];
  const run: WorkflowRunFunction = async (target, init) => {
    calls.push({ target, init });
    throw new Error('recordingRun: no result configured');
  };

  return { run, calls };
};
