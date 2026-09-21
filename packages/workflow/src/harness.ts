/** In-memory testing adapter. No persistence, native scheduling, or Cloudflare runtime. */
import { isNonRetryableError } from './errors';
import { createWorkflowRunContext } from './run-context';
import type {
  WorkflowDefinition,
  WorkflowEventLike,
  WorkflowRunFunction,
  WorkflowStepConfigLike,
  WorkflowStepContextLike,
  WorkflowStepLike,
  WorkflowStepRollbackOptionsLike,
} from './types';

export class WorkflowSuspended extends Error {
  constructor(
    readonly waitName: string,
    readonly eventType: string,
  ) {
    super(`workflow suspended at waitForEvent(${JSON.stringify(waitName)})`);
    this.name = 'WorkflowSuspended';
  }
}

export interface HarnessEvent {
  type: string;
  payload: unknown;
}

export interface RunToCompletionOptions<Params = Record<string, unknown>> {
  /** Use the same params for every replay of this instance. */
  params: Params;
  /** Scoped to this instance; cannot change between replays. */
  env?: Record<string, unknown>;
  run?: WorkflowRunFunction;
  /** Delivery is addressed by wait name and must match the expected event type. */
  deliver?: Record<string, HarnessEvent>;
  /** Bounds automatic event replays, not arbitrary handler execution time. */
  maxReplays?: number;
}

export type HarnessResult<Output = unknown> =
  | { status: 'complete'; output: Awaited<Output>; suspendedAt?: never; replays: number }
  | { status: 'suspended'; suspendedAt: string; output?: never; replays: number };

export interface ReplayHarness {
  readonly step: WorkflowStepLike;
  runToCompletion: <Params, Output>(
    definition: WorkflowDefinition<Params, Output>,
    options: RunToCompletionOptions<Params>,
  ) => Promise<HarnessResult<Output>>;
  /** Includes failed attempts; cached reads do not count. */
  invocations: (name: string) => number;
  ran: (name: string) => boolean;
  completedSteps: () => string[];
  deliveredEvents: () => string[];
  /** Clear state before testing a different instance. Fails while work is pending. */
  reset: () => void;
}

const defaultRun: WorkflowRunFunction = async () => {
  throw new Error(
    '@velajs/workflow harness: ctx.run was called but no `run` double was supplied to runToCompletion',
  );
};

/** Stable JSON identity prevents replaying a tenant's log with different trigger params. */
const paramsKey = (value: unknown, ancestors = new Set<object>()): string => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || value === null || ancestors.has(value)) {
    throw new TypeError('harness: params must be acyclic JSON values');
  }
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw new TypeError('harness: params must contain only plain JSON objects');
  }
  const next = new Set(ancestors).add(value);
  if (Array.isArray(value))
    return `[${Array.from(value, (entry) => paramsKey(entry, next)).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${paramsKey(entry, next)}`)
    .join(',')}}`;
};

/**
 * One harness per instance. Labels are unique memoization keys: use distinct
 * labels for loop iterations. Retry attempts run immediately; sleeps record a
 * checkpoint without waiting. Timeouts, backoff timing, and rollback are not simulated.
 */
export const createReplayHarness = (): ReplayHarness => {
  const stepLog = new Map<string, unknown>();
  const eventLog = new Map<string, HarnessEvent>();
  const invocationCounts = new Map<string, number>();
  const pendingSteps = new Map<string, Promise<unknown>>();
  const labels = new Map<string, string>();
  let instanceId = crypto.randomUUID();
  let active = false;
  let definitionIdentity: object | undefined;
  let paramsIdentity: string | undefined;
  let instanceEnv: Record<string, unknown> | undefined;
  const timestamp = new Date(0);

  const label = (name: string, kind: string): void => {
    if (!name.trim()) throw new TypeError('harness: step name must not be empty');
    const previous = labels.get(name);
    if (previous !== undefined && previous !== kind) {
      throw new Error(`harness: label "${name}" reused for ${kind} after ${previous}`);
    }
    labels.set(name, kind);
  };

  async function stepDo<T>(
    name: string,
    configOrCallback: WorkflowStepConfigLike | ((context: WorkflowStepContextLike) => Promise<T>),
    callbackOrRollback?:
      | ((context: WorkflowStepContextLike) => Promise<T>)
      | WorkflowStepRollbackOptionsLike<T>,
    rollback?: WorkflowStepRollbackOptionsLike<T>,
  ): Promise<T> {
    const config = typeof configOrCallback === 'function' ? {} : configOrCallback;
    const callback = typeof configOrCallback === 'function' ? configOrCallback : callbackOrRollback;
    const compensation = typeof configOrCallback === 'function' ? callbackOrRollback : rollback;
    if (compensation !== undefined) {
      throw new Error(
        'harness: rollback is not simulated; use an execution adapter to test compensation',
      );
    }
    if (typeof callback !== 'function') throw new TypeError('harness: step.do requires a callback');
    const retries = config.retries?.limit ?? 0;
    if (!Number.isSafeInteger(retries) || retries < 0) {
      throw new RangeError('harness: retries.limit must be a non-negative safe integer');
    }
    label(name, 'do');
    if (stepLog.has(name)) return structuredClone(stepLog.get(name)) as T;
    const pending = pendingSteps.get(name);
    if (pending !== undefined) return structuredClone(await pending) as T;

    // Defer the callback so the pending promise is visible to concurrent callers.
    const work = Promise.resolve().then(async () => {
      for (let attempt = 1; ; attempt += 1) {
        const count = (invocationCounts.get(name) ?? 0) + 1;
        invocationCounts.set(name, count);
        let result: T;
        try {
          result = await callback({
            attempt,
            config: structuredClone(config),
            step: { name, count: 1 },
          });
        } catch (error: unknown) {
          if (error instanceof WorkflowSuspended || isNonRetryableError(error) || attempt > retries)
            throw error;
          continue;
        }
        // A non-cloneable result is a serialization failure, not a transient body error.
        const saved = structuredClone(result);
        stepLog.set(name, saved);
        return saved;
      }
    });
    pendingSteps.set(name, work);
    try {
      return structuredClone(await work);
    } finally {
      pendingSteps.delete(name);
    }
  }

  const recordSleep = async (name: string, kind: string): Promise<void> => {
    label(name, kind);
    stepLog.set(name, undefined);
  };

  const step: WorkflowStepLike = {
    do: stepDo,
    sleep: (name) => recordSleep(name, 'sleep'),
    sleepUntil: (name) => recordSleep(name, 'sleepUntil'),
    waitForEvent: async (name, options) => {
      label(name, `event:${options.type}`);
      const existing = eventLog.get(name);
      if (existing !== undefined) return structuredClone(existing);
      throw new WorkflowSuspended(name, options.type);
    },
  };

  const runToCompletion = async <Params, Output>(
    definition: WorkflowDefinition<Params, Output>,
    options: RunToCompletionOptions<Params>,
  ): Promise<HarnessResult<Output>> => {
    if (active || pendingSteps.size) throw new Error('harness: another execution is still active');
    if (definitionIdentity !== undefined && definitionIdentity !== definition) {
      throw new Error('harness: a different workflow requires a fresh harness or reset()');
    }
    if (instanceEnv !== undefined && options.env !== undefined && options.env !== instanceEnv) {
      throw new Error('harness: a different environment requires a fresh harness or reset()');
    }
    const maxReplays = options.maxReplays ?? 100;
    if (!Number.isSafeInteger(maxReplays) || maxReplays < 1) {
      throw new RangeError('harness: maxReplays must be a positive safe integer');
    }
    const identity = paramsKey(options.params);
    if (paramsIdentity !== undefined && identity !== paramsIdentity) {
      throw new Error('harness: different params require a fresh harness or reset()');
    }
    paramsIdentity = identity;
    definitionIdentity = definition;
    instanceEnv ??= options.env ?? {};
    const env = instanceEnv;
    const run = options.run ?? defaultRun;
    const pending = new Map(
      Object.entries(options.deliver ?? {}).map(([name, event]) => [name, structuredClone(event)]),
    );
    const exportName = definition.name ?? 'workflow';
    const event: WorkflowEventLike<Params> = {
      instanceId,
      payload: structuredClone(options.params),
      timestamp,
      workflowName: exportName,
    };
    active = true;
    try {
      for (let replays = 1; replays <= maxReplays; replays += 1) {
        const context = createWorkflowRunContext({
          env,
          event: structuredClone(event),
          exportName,
          run,
          step,
        });
        try {
          const output = await definition.handler(context);
          return { status: 'complete', output, replays };
        } catch (error: unknown) {
          if (!(error instanceof WorkflowSuspended)) throw error;
          const delivered = pending.get(error.waitName);
          if (
            delivered !== undefined &&
            delivered.type === error.eventType &&
            !eventLog.has(error.waitName)
          ) {
            eventLog.set(error.waitName, delivered);
            pending.delete(error.waitName);
            continue;
          }
          return { status: 'suspended', suspendedAt: error.waitName, replays };
        }
      }
      throw new Error(
        `@velajs/workflow harness: exceeded ${String(maxReplays)} replays without completing`,
      );
    } finally {
      active = false;
    }
  };

  return {
    step,
    runToCompletion,
    invocations: (name) => invocationCounts.get(name) ?? 0,
    ran: (name) => (invocationCounts.get(name) ?? 0) > 0,
    completedSteps: () => [...stepLog.keys()],
    deliveredEvents: () => [...eventLog.keys()],
    reset: () => {
      if (active || pendingSteps.size)
        throw new Error('harness: cannot reset while execution is active');
      stepLog.clear();
      eventLog.clear();
      invocationCounts.clear();
      labels.clear();
      definitionIdentity = undefined;
      paramsIdentity = undefined;
      instanceEnv = undefined;
      instanceId = crypto.randomUUID();
    },
  };
};
