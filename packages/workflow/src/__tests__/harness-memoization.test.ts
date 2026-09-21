import { describe, expect, it } from 'vitest';

import { defineWorkflow } from '../index';
import { createReplayHarness } from '../harness';

/**
 * ACCEPTANCE — `step.do` memoization + duplicate-delivery idempotency.
 *
 * A durable step's body must run exactly once and be replayed (body skipped) on
 * every subsequent handler invocation. This is the replay-safety contract the
 * future `@velajs/agent` port relies on (step name = tool idempotency key).
 */
describe('acceptance: step.do memoization', () => {
  it('runs a step body exactly once across N handler replays', async () => {
    const harness = createReplayHarness();
    let bodyRuns = 0;

    const wf = defineWorkflow<{ id: string }, number>({
      handler: async (ctx) =>
        ctx.step.do('compute', async () => {
          bodyRuns += 1;
          return 42;
        }),
    });

    // First run populates the durable log.
    const first = await harness.runToCompletion(wf, { params: { id: 'a' } });
    expect(first.status).toBe('complete');
    expect(first.output).toBe(42);
    expect(bodyRuns).toBe(1);
    expect(harness.invocations('compute')).toBe(1);

    // Re-running the SAME instance is a replay: the body is never re-invoked.
    for (let i = 0; i < 5; i += 1) {
      const again = await harness.runToCompletion(wf, { params: { id: 'a' } });
      expect(again.status).toBe('complete');
      expect(again.output).toBe(42); // identical stored result
    }

    expect(bodyRuns).toBe(1);
    expect(harness.invocations('compute')).toBe(1);
  });

  it('memoizes each named step independently and preserves order', async () => {
    const harness = createReplayHarness();
    const ran: string[] = [];

    const wf = defineWorkflow<Record<string, never>, string>({
      handler: async (ctx) => {
        const a = await ctx.step.do('a', async () => {
          ran.push('a');
          return 'A';
        });
        await ctx.step.sleep('cool-off', '1 minute');
        const b = await ctx.step.do('b', async () => {
          ran.push('b');
          return 'B';
        });
        return a + b;
      },
    });

    const first = await harness.runToCompletion(wf, { params: {} });
    expect(first.output).toBe('AB');

    // Duplicate delivery of the same instance — idempotent, re-runs nothing.
    const second = await harness.runToCompletion(wf, { params: {} });
    expect(second.output).toBe('AB');

    expect(ran).toEqual(['a', 'b']); // each body ran once, in order
    expect(harness.invocations('a')).toBe(1);
    expect(harness.invocations('b')).toBe(1);
    expect(harness.completedSteps()).toContain('cool-off'); // sleep recorded as a durable no-op
  });

  it('reset() clears the log so the instance runs fresh again', async () => {
    const harness = createReplayHarness();
    let bodyRuns = 0;
    const wf = defineWorkflow<Record<string, never>, string>({
      handler: async (ctx) =>
        ctx.step.do('s', async () => {
          bodyRuns += 1;
          return 'x';
        }),
    });

    await harness.runToCompletion(wf, { params: {} });
    harness.reset();
    await harness.runToCompletion(wf, { params: {} });

    expect(bodyRuns).toBe(2); // fresh instance re-ran the body
  });
});
