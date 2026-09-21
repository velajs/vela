import { describe, expect, it } from 'vitest';
import { createReplayHarness } from '../harness';
import { defineWorkflow, WorkflowNonRetryableError } from '../index';
import { VelaError } from '@velajs/errors';

describe('replay harness contract', () => {
  it('retries only failed attempts and forwards attempt/config metadata', async () => {
    const harness = createReplayHarness();
    const attempts: number[] = [];
    const config = { retries: { limit: 2, delay: '1 second' } };
    const result = await harness.step.do('retry', config, async (ctx) => {
      attempts.push(ctx.attempt);
      expect(ctx.config).toEqual(config);
      expect(ctx.step).toEqual({ name: 'retry', count: 1 });
      if (ctx.attempt < 3) throw new Error('transient');
      return 42;
    });
    expect(result).toBe(42);
    expect(attempts).toEqual([1, 2, 3]);
    expect(harness.invocations('retry')).toBe(3);
    expect(await harness.step.do('retry', async () => 0)).toBe(42);
  });

  it('propagates exhausted errors unchanged and stops immediately for terminal errors', async () => {
    const harness = createReplayHarness();
    const transient = new VelaError('gateway_timeout');
    await expect(
      harness.step.do('exhaust', { retries: { limit: 2 } }, async () => {
        throw transient;
      }),
    ).rejects.toBe(transient);
    expect(harness.invocations('exhaust')).toBe(3);
    expect(harness.completedSteps()).not.toContain('exhaust');
    const terminal = new WorkflowNonRetryableError('stop', 'CustomName');
    await expect(
      harness.step.do('terminal', { retries: { limit: 5 } }, async () => {
        throw terminal;
      }),
    ).rejects.toBe(terminal);
    expect(harness.invocations('terminal')).toBe(1);
  });

  it('defaults to no retries and rejects invalid retry limits', async () => {
    const harness = createReplayHarness();
    await expect(
      harness.step.do('once', async () => {
        throw new Error('fail');
      }),
    ).rejects.toThrow('fail');
    expect(harness.invocations('once')).toBe(1);
    for (const limit of [-1, 1.5, Infinity, NaN]) {
      await expect(
        harness.step.do('invalid', { retries: { limit } }, async () => 0),
      ).rejects.toThrow('retries.limit');
    }
    expect(harness.ran('invalid')).toBe(false);
  });

  it('shares pending work but gives every caller a copy of successful results', async () => {
    const harness = createReplayHarness();
    const source = { values: ['saved'] };
    const [first, concurrent] = await Promise.all([
      harness.step.do('shared', async () => source),
      harness.step.do('shared', async () => ({ values: ['wrong'] })),
    ]);
    first.values.push('mutated');
    source.values.push('source mutation');
    expect(concurrent).toEqual({ values: ['saved'] });
    expect(await harness.step.do('shared', async () => ({}))).toEqual({ values: ['saved'] });
    expect(harness.invocations('shared')).toBe(1);
    await expect(harness.step.do('uncloneable', async () => () => {})).rejects.toThrow();
    expect(harness.completedSteps()).not.toContain('uncloneable');
    await harness.step.do('undefined', async () => undefined);
    expect(await harness.step.do('undefined', async () => 1)).toBeUndefined();
  });

  it('requires matching event types and keeps the first accepted payload on replay', async () => {
    const harness = createReplayHarness();
    const workflow = defineWorkflow({
      handler: (ctx) => ctx.step.waitForEvent('gate', { type: 'approve' }),
    });
    expect(
      await harness.runToCompletion(workflow, {
        params: {},
        deliver: { gate: { type: 'reject', payload: 'bad' } },
      }),
    ).toMatchObject({ status: 'suspended' });
    expect(harness.deliveredEvents()).toEqual([]);
    const payload = { approved: true };
    const first = await harness.runToCompletion(workflow, {
      params: {},
      deliver: { gate: { type: 'approve', payload } },
    });
    expect(first).toMatchObject({ status: 'complete', output: { payload: { approved: true } } });
    payload.approved = false;
    expect(
      await harness.runToCompletion(workflow, {
        params: {},
        deliver: { gate: { type: 'approve', payload: 'duplicate' } },
      }),
    ).toMatchObject({ output: { payload: { approved: true } } });
    await expect(harness.step.waitForEvent('gate', { type: 'changed' })).rejects.toThrow('reused');
    await expect(harness.step.do('gate', async () => 0)).rejects.toThrow('reused');
  });

  it('replays calls outside step.do but memoizes dispatch inside step.do', async () => {
    let calls = 0;
    const harness = createReplayHarness();
    const workflow = defineWorkflow({
      handler: async (ctx) => {
        await ctx.run({ path: '/unwrapped' });
        await ctx.step.do('wrapped', () => ctx.run({ path: '/wrapped' }));
        return ctx.step.waitForEvent('gate', { type: 'go' });
      },
    });
    const run = async () => {
      calls += 1;
      return calls;
    };
    await harness.runToCompletion(workflow, { params: {}, run });
    expect(calls).toBe(2);
    await harness.runToCompletion(workflow, {
      params: {},
      run,
      deliver: { gate: { type: 'go', payload: null } },
    });
    expect(calls).toBe(4); // two handler replays on delivery, neither repeats the wrapped call
    expect(harness.invocations('wrapped')).toBe(1);
  });

  it('isolates instance definitions, trigger params, and environments', async () => {
    const a = createReplayHarness();
    const b = createReplayHarness();
    const workflow = defineWorkflow<{ tenant: string }, unknown>({
      handler: (ctx) => ctx.step.do('tenant', async () => ctx.env.tenant),
    });
    const envA = { tenant: 'a' };
    const envB = { tenant: 'b' };
    expect(await a.runToCompletion(workflow, { params: { tenant: 'a' }, env: envA })).toMatchObject(
      { output: 'a' },
    );
    expect(await b.runToCompletion(workflow, { params: { tenant: 'b' }, env: envB })).toMatchObject(
      { output: 'b' },
    );
    await expect(
      a.runToCompletion(workflow, { params: { tenant: 'a' }, env: envB }),
    ).rejects.toThrow('different environment');
    await expect(a.runToCompletion(workflow, { params: { tenant: 'b' } })).rejects.toThrow(
      'different params',
    );
    await expect(
      a.runToCompletion(defineWorkflow({ handler: () => 0 }), { params: {} }),
    ).rejects.toThrow('different workflow');
    a.reset();
    expect(await a.runToCompletion(workflow, { params: { tenant: 'b' }, env: envB })).toMatchObject(
      { output: 'b' },
    );
  });

  it('rejects overlapping runs and reset while a step is active', async () => {
    const harness = createReplayHarness();
    const deferred = Promise.withResolvers<number>();
    const workflow = defineWorkflow({
      handler: (ctx) => ctx.step.do('wait', () => deferred.promise),
    });
    const pending = harness.runToCompletion(workflow, { params: {} });
    await expect(harness.runToCompletion(workflow, { params: {} })).rejects.toThrow('still active');
    expect(() => harness.reset()).toThrow('cannot reset');
    deferred.resolve(3);
    expect(await pending).toMatchObject({ output: 3 });
    harness.reset();
    expect(harness.completedSteps()).toEqual([]);
  });

  it('bounds automatic replays and rejects unsupported compensation', async () => {
    const harness = createReplayHarness();
    const workflow = defineWorkflow({
      handler: (ctx) => ctx.step.waitForEvent('gate', { type: 'go' }),
    });
    await expect(harness.runToCompletion(workflow, { params: {}, maxReplays: 0 })).rejects.toThrow(
      'positive safe integer',
    );
    await expect(
      harness.runToCompletion(workflow, {
        params: {},
        maxReplays: 1,
        deliver: { gate: { type: 'go', payload: null } },
      }),
    ).rejects.toThrow('exceeded 1 replays');
    await expect(
      harness.step.do('compensated', async () => 1, { rollback: async () => {} }),
    ).rejects.toThrow('rollback is not simulated');
  });
});
