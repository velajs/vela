import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  createWorkflowRunContext,
  defineStep,
  validateStepArgs,
  WorkflowNonRetryableError,
} from '../index';
import type { InferStepInput } from '../index';
import { createReplayHarness } from '../harness';

const context = () => {
  const harness = createReplayHarness();
  return {
    harness,
    ctx: createWorkflowRunContext({
      env: {},
      event: { instanceId: 'test', payload: {}, timestamp: new Date(0), workflowName: 'test' },
      exportName: 'test',
      run: async () => ({ raw: 'external' }),
      step: harness.step,
    }),
  };
};

describe('Zod 4 validation contract', () => {
  it('accepts raw transforms, omitted defaults and optional args; returns parsed schema output', async () => {
    const step = defineStep({
      name: 'transform',
      args: {
        length: z.string().transform((v) => v.length),
        count: z.number().default(2),
        note: z.string().optional(),
      },
      returns: z.string().transform((v) => ({ total: Number(v) })),
      handler: (_ctx, args) => {
        expectTypeOf(args.length).toEqualTypeOf<number>();
        expectTypeOf(args.count).toEqualTypeOf<number>();
        expectTypeOf(args.note).toEqualTypeOf<string | undefined>();
        return String(args.length * args.count);
      },
    });
    const input: InferStepInput<typeof step.args> = { length: 'abc' };
    const { ctx } = context();
    const output = await ctx.runStep(step, input);
    expectTypeOf(output).toEqualTypeOf<{ total: number }>();
    expect(output).toEqual({ total: 6 });
    // @ts-expect-error handler receives a number, but callers supply the raw string
    void ctx.runStep(step, { length: 3 }).catch(() => {});
  });

  it('parses unknown dispatch output before assigning a domain type', async () => {
    const step = defineStep({
      name: 'external',
      args: {},
      returns: z.object({ raw: z.string() }),
      handler: (ctx) => ctx.run({ path: '/external' }),
    });
    const { ctx } = context();
    expectTypeOf(await ctx.run({ path: '/external' })).toEqualTypeOf<unknown>();
    const result = await ctx.runStep(step, {});
    expectTypeOf(result).toEqualTypeOf<{ raw: string }>();
    expect(result.raw).toBe('external');
  });

  it('rejects non-record inputs and inherited args, and strips undeclared keys', () => {
    expect(() => validateStepArgs({ id: z.string() }, Object.create({ id: 'inherited' }))).toThrow(
      WorkflowNonRetryableError,
    );
    for (const input of [null, undefined, [], 'text']) {
      expect(() => validateStepArgs({}, input)).toThrow(WorkflowNonRetryableError);
    }
    expect(validateStepArgs({ id: z.string() }, { id: 'ok', secret: 'ignored' })).toEqual({
      id: 'ok',
    });
    const shape = { ['__proto__']: z.string() };
    const result = validateStepArgs(shape, { ['__proto__']: 'safe' });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
  });

  it('rejects invalid args before any effect and makes invalid output terminal', async () => {
    const { ctx, harness } = context();
    const invalidArgs = defineStep({
      name: 'args',
      args: { id: z.string().min(2) },
      handler: () => 'ok',
    });
    await expect(ctx.runStep(invalidArgs, { id: 'x' })).rejects.toThrow(WorkflowNonRetryableError);
    expect(harness.invocations('args')).toBe(0);
    const invalidReturn = defineStep({
      name: 'output',
      args: {},
      returns: z.number(),
      handler: () => 'wrong',
      config: { retries: { limit: 3 } },
    });
    await expect(ctx.runStep(invalidReturn, {})).rejects.toThrow(WorkflowNonRetryableError);
    expect(harness.invocations('output')).toBe(1);
  });

  it('supports repeated definitions with explicit stable per-call names', async () => {
    const { ctx, harness } = context();
    const step = defineStep({
      name: 'double',
      args: { n: z.number() },
      handler: (_ctx, { n }) => n * 2,
    });
    expect(await ctx.runStep(step, { n: 2 }, { name: 'double:2' })).toBe(4);
    expect(await ctx.runStep(step, { n: 3 }, { name: 'double:3' })).toBe(6);
    expect(await ctx.runStep(step, { n: 2 }, { name: 'double:2' })).toBe(4);
    expect(harness.invocations('double:2')).toBe(1);
  });
});
