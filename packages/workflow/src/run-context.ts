/** Assemble a per-invocation context from caller-supplied execution dependencies. */
import { createRunStep } from './run-step';
import type { NativeNonRetryableErrorConstructor } from './errors';
import type {
  WorkflowEventLike,
  WorkflowLogger,
  WorkflowRunContext,
  WorkflowRunFunction,
  WorkflowStepLike,
} from './types';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** A small console-backed logger that prepends a fixed workflow prefix to each line. */
export const createWorkflowLogger = (prefix: string): WorkflowLogger => {
  const at =
    (level: LogLevel) =>
    (message: string, ...rest: unknown[]): void => {
      // oxlint-disable-next-line no-console -- workflow log lines are meant to reach `wrangler tail`
      console[level](`${prefix} ${message}`, ...rest);
    };

  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
};

/** Inputs for {@link createWorkflowRunContext}. */
export interface WorkflowRunContextOptions<Params> {
  env: Record<string, unknown>;
  event: WorkflowEventLike<Params>;
  /** The workflow export name — drives log correlation and the default deploy name. */
  exportName: string;
  /** The injected dispatch function; this helper adds no authentication or transport. */
  run: WorkflowRunFunction;
  /** The execution adapter. */
  step: WorkflowStepLike;
  /** Optional terminal-error constructor supplied by an execution adapter. */
  nonRetryableErrorClass?: NativeNonRetryableErrorConstructor;
}

/** Build a context without global state or automatic platform wiring. */
export const createWorkflowRunContext = <Params = Record<string, unknown>>(
  options: WorkflowRunContextOptions<Params>,
): WorkflowRunContext<Params> => {
  const log = createWorkflowLogger(`[workflow:${options.exportName}]`);

  return {
    env: options.env,
    event: options.event,
    log,
    params: options.event.payload,
    run: options.run,
    runStep: createRunStep({
      env: options.env,
      log,
      run: options.run,
      step: options.step,
      // Pass the native ctor through only when it exists —
      // `exactOptionalPropertyTypes` rejects an explicit `undefined` on the
      // optional field.
      ...(options.nonRetryableErrorClass !== undefined
        ? { nonRetryableErrorClass: options.nonRetryableErrorClass }
        : {}),
    }),
    step: options.step,
  };
};
