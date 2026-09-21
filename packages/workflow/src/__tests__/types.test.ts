import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { createWorkflowRunContext, defineStep, defineWorkflow } from '../index';
import type {
  InferStepArgs,
  StepDefinition,
  WorkflowDefinition,
  WorkflowEventLike,
  WorkflowRunContext,
  WorkflowRunFunction,
  WorkflowRunTarget,
} from '../index';
import { immediateStep, rejectingRun } from './support';

const event = (): WorkflowEventLike<{ orderId: string }> => ({
  instanceId: 'i',
  payload: { orderId: 'o' },
  timestamp: new Date(0),
  workflowName: 'w',
});

describe('defineWorkflow type inference', () => {
  it('infers Params on the context and carries Params/Output on the definition', () => {
    const wf = defineWorkflow<{ orderId: string }, number>({
      handler: async (ctx) => {
        expectTypeOf(ctx.params).toEqualTypeOf<Readonly<{ orderId: string }>>();
        expectTypeOf(ctx.event.payload).toEqualTypeOf<Readonly<{ orderId: string }>>();
        expectTypeOf(ctx.run).toEqualTypeOf<WorkflowRunFunction>();
        return ctx.params.orderId.length;
      },
    });

    expectTypeOf(wf).toEqualTypeOf<WorkflowDefinition<{ orderId: string }, number>>();
    expect(wf.isVelaWorkflow).toBe(true);
  });
});

describe('defineStep type inference', () => {
  it('infers the args object from the zod map and the Result from the handler', () => {
    const step = defineStep({
      name: 's',
      args: { id: z.string(), count: z.number() },
      handler: async (_ctx, args) => {
        expectTypeOf(args).toEqualTypeOf<{ id: string; count: number }>();
        return args.count + args.id.length;
      },
    });

    expectTypeOf(step).toEqualTypeOf<
      StepDefinition<{ id: z.ZodString; count: z.ZodNumber }, number>
    >();
    expect(step.name).toBe('s');
  });

  it('InferStepArgs maps a zod shape to its parsed values', () => {
    expectTypeOf<InferStepArgs<{ id: z.ZodString; on: z.ZodBoolean }>>().toEqualTypeOf<{
      id: string;
      on: boolean;
    }>();
  });

  it('ctx.runStep infers args from the step and returns the step Result', () => {
    const step = defineStep({
      name: 'charge',
      args: { amount: z.number() },
      returns: z.object({ receiptId: z.string() }),
      handler: async (_ctx, { amount }) => ({ receiptId: `r-${String(amount)}` }),
    });

    const ctx = createWorkflowRunContext({
      env: {},
      event: event(),
      exportName: 'w',
      run: rejectingRun,
      step: immediateStep(),
    });

    expectTypeOf(ctx.runStep(step, { amount: 5 })).toEqualTypeOf<Promise<{ receiptId: string }>>();
    expect(typeof ctx.runStep).toBe('function');
  });
});

describe('WorkflowRunFunction boundary', () => {
  it('keeps external results unknown', () => {
    // Type-level only — instantiation expressions, never a runtime call.
    expectTypeOf(rejectingRun).returns.toEqualTypeOf<Promise<unknown>>();

    expectTypeOf(rejectingRun).parameter(0).toEqualTypeOf<WorkflowRunTarget>();
    expectTypeOf(rejectingRun).toBeCallableWith({ path: '/x' });
    expectTypeOf(rejectingRun).toBeCallableWith({ route: 'r', params: { id: '1' } });
  });
});

describe('WorkflowRunContext shape', () => {
  it('exposes the documented surface', () => {
    expectTypeOf<WorkflowRunContext<{ a: number }>['params']>().toEqualTypeOf<
      Readonly<{ a: number }>
    >();
    expectTypeOf<WorkflowRunContext['run']>().toEqualTypeOf<WorkflowRunFunction>();
  });
});
