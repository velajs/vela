import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createRunStep, defineStep, WorkflowNonRetryableError } from '../index';
import type {
  StepRunContext,
  WorkflowLogger,
  WorkflowRunFunction,
  WorkflowStepConfigLike,
  WorkflowStepContextLike,
  WorkflowStepLike,
} from '../index';
import { immediateStep, rejectingRun } from './support';

const silentLogger: WorkflowLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const deps = (
  step: WorkflowStepLike,
  extra?: {
    run?: WorkflowRunFunction;
    nonRetryableErrorClass?: new (m: string, n?: string) => Error;
  },
) => ({
  env: {},
  log: silentLogger,
  run: extra?.run ?? rejectingRun,
  step,
  ...(extra?.nonRetryableErrorClass !== undefined
    ? { nonRetryableErrorClass: extra.nonRetryableErrorClass }
    : {}),
});

describe('createRunStep — arg validation', () => {
  it('validates args and prefixes failures with `step args.<key>`', async () => {
    const runStep = createRunStep(deps(immediateStep()));
    const step = defineStep({
      name: 'greet',
      args: { name: z.string().min(5) },
      handler: async (_ctx, { name }) => name.toUpperCase(),
    });

    // A type-valid string that fails the zod refinement — no cast needed.
    await expect(runStep(step, { name: 'ab' })).rejects.toThrow(/^step args\.name:/);
  });

  it('passes validated args to the handler', async () => {
    const runStep = createRunStep(deps(immediateStep()));
    const step = defineStep({
      name: 'greet',
      args: { name: z.string() },
      handler: async (_ctx, { name }) => `hi ${name}`,
    });

    await expect(runStep(step, { name: 'ada' })).resolves.toBe('hi ada');
  });
});

describe('createRunStep — returns validation', () => {
  it('returns the validated result on success', async () => {
    const runStep = createRunStep(deps(immediateStep()));
    const step = defineStep({
      name: 'code',
      args: {},
      returns: z.string().min(2),
      handler: async () => 'ok',
    });

    await expect(runStep(step, {})).resolves.toBe('ok');
  });

  it('converts a deterministic returns failure to a non-retryable error (Node path)', async () => {
    const runStep = createRunStep(deps(immediateStep()));
    const step = defineStep({
      name: 'code',
      args: {},
      returns: z.string().min(5),
      handler: async () => 'ab', // valid string type, fails min(5) at runtime
    });

    await expect(runStep(step, {})).rejects.toBeInstanceOf(WorkflowNonRetryableError);
    await expect(runStep(step, {})).rejects.toThrow(/does not match its returns schema/);
  });

  it('rebuilds the returns failure as the native error when a native ctor is injected', async () => {
    class NativeNonRetryable extends Error {
      constructor(message: string, name = 'NonRetryableError') {
        super(message);
        this.name = name;
      }
    }
    const runStep = createRunStep(
      deps(immediateStep(), { nonRetryableErrorClass: NativeNonRetryable }),
    );
    const step = defineStep({
      name: 'code',
      args: {},
      returns: z.string().min(5),
      handler: async () => 'ab',
    });

    await expect(runStep(step, {})).rejects.toBeInstanceOf(NativeNonRetryable);
  });

  it('keeps a body throw retryable (rethrown as-is, not converted)', async () => {
    const runStep = createRunStep(deps(immediateStep()));
    const boom = new Error('transient');
    const step = defineStep({
      name: 'flaky',
      args: {},
      handler: async () => {
        throw boom;
      },
    });

    await expect(runStep(step, {})).rejects.toThrowError(boom);
  });
});

describe('createRunStep — rollback forwarding', () => {
  it('forwards a declared rollback to step.do and runs the user handler with the validated args', async () => {
    let capturedRollback: unknown;
    const capturingStep: WorkflowStepLike = {
      do: <T>(
        name: string,
        a: WorkflowStepConfigLike | ((context: WorkflowStepContextLike) => Promise<T>),
        b?: unknown,
        c?: unknown,
      ): Promise<T> => {
        const callback = (typeof a === 'function' ? a : b) as (
          context: WorkflowStepContextLike,
        ) => Promise<T>;
        capturedRollback = typeof a === 'function' ? b : c;
        return callback({ attempt: 1, config: {}, step: { name, count: 1 } });
      },
      sleep: async () => {},
      sleepUntil: async () => {},
      waitForEvent: () => Promise.reject(new Error('unused')),
    };

    const rollbackHandler = vi.fn();
    const runStep = createRunStep(deps(capturingStep));
    const step = defineStep({
      name: 'reserve',
      args: { sku: z.string() },
      handler: async (_ctx, { sku }) => `reserved:${sku}`,
      rollback: rollbackHandler,
    });

    await expect(runStep(step, { sku: 'A1' })).resolves.toBe('reserved:A1');

    // The rollback was forwarded to step.do; invoke it as the platform would.
    const opts = capturedRollback as {
      rollback: (ctx: { error: Error; output: unknown }) => Promise<void>;
    };
    expect(typeof opts.rollback).toBe('function');
    const cause = new Error('later step failed');
    await opts.rollback({ error: cause, output: 'reserved:A1' });

    expect(rollbackHandler).toHaveBeenCalledOnce();
    expect(rollbackHandler.mock.calls[0]?.[0]).toMatchObject({
      args: { sku: 'A1' },
      error: cause,
      output: 'reserved:A1',
    });
  });
});

describe('createRunStep — run seam', () => {
  it('threads the injected run onto the step context', async () => {
    const { run } = { run: rejectingRun };
    let seen: WorkflowRunFunction | undefined;
    const runStep = createRunStep(deps(immediateStep(), { run }));
    const step = defineStep({
      name: 'inspect',
      args: {},
      handler: async (ctx: StepRunContext) => {
        seen = ctx.run;
        return 'done';
      },
    });

    await runStep(step, {});
    expect(seen).toBe(run);
  });
});
