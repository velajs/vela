import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { defineWorkflow } from '../index';
import { createReplayHarness, WorkflowSuspended } from '../harness';

/**
 * ACCEPTANCE — `step.waitForEvent` hibernation.
 *
 * The workflow suspends at the wait; a later delivered event resumes it; every
 * step before the wait stays memoized (not re-run). This is the human-in-the-
 * loop approval replay-safety the future `@velajs/agent` port relies on.
 */
describe('acceptance: step.waitForEvent hibernation', () => {
  it('suspends at the wait with nothing after it run, then resumes on delivery without re-running prior steps', async () => {
    const harness = createReplayHarness();
    let prepareRuns = 0;
    let finalizeRuns = 0;
    const order: string[] = [];

    const wf = defineWorkflow<{ id: string }, string>({
      handler: async (ctx) => {
        await ctx.step.do('prepare', async () => {
          prepareRuns += 1;
          order.push('prepare');
          return 'ready';
        });

        const approval = await ctx.step.waitForEvent('approval', {
          type: 'approved',
        });

        await ctx.step.do('finalize', async () => {
          finalizeRuns += 1;
          order.push('finalize');
          return 'done';
        });

        return `${approval.type}:${z.object({ approvedBy: z.string() }).parse(approval.payload).approvedBy}`;
      },
    });

    // First run: reaches the wait, hibernates. Everything before the wait ran;
    // nothing after it did.
    const suspended = await harness.runToCompletion(wf, { params: { id: 'x' } });
    expect(suspended.status).toBe('suspended');
    expect(suspended.suspendedAt).toBe('approval');
    expect(prepareRuns).toBe(1);
    expect(finalizeRuns).toBe(0);
    expect(harness.ran('prepare')).toBe(true);
    expect(harness.ran('finalize')).toBe(false);
    expect(order).toEqual(['prepare']);

    // Deliver the event and resume. The pre-wait step is memoized (not re-run);
    // the post-wait step runs exactly once.
    const resumed = await harness.runToCompletion(wf, {
      params: { id: 'x' },
      deliver: { approval: { type: 'approved', payload: { approvedBy: 'ada' } } },
    });

    expect(resumed.status).toBe('complete');
    expect(resumed.output).toBe('approved:ada');
    expect(prepareRuns).toBe(1); // NOT re-run on resume
    expect(finalizeRuns).toBe(1);
    expect(order).toEqual(['prepare', 'finalize']);
    expect(harness.invocations('prepare')).toBe(1);
    expect(harness.invocations('finalize')).toBe(1);
  });

  it('resumes within a single runToCompletion when the event is delivered up front', async () => {
    const harness = createReplayHarness();
    let prepareRuns = 0;

    const wf = defineWorkflow<Record<string, never>, string>({
      handler: async (ctx) => {
        await ctx.step.do('prepare', async () => {
          prepareRuns += 1;
          return 'ready';
        });
        const evt = await ctx.step.waitForEvent('gate', { type: 'go' });
        return evt.type;
      },
    });

    const result = await harness.runToCompletion(wf, {
      params: {},
      deliver: { gate: { type: 'go', payload: null } },
    });

    expect(result.status).toBe('complete');
    expect(result.output).toBe('go');
    // Suspended once then replayed once => the body invocation happened exactly once.
    expect(result.replays).toBe(2);
    expect(prepareRuns).toBe(1);
  });

  it('exposes the WorkflowSuspended sentinel with the wait name and event type', async () => {
    const harness = createReplayHarness();
    let caught: unknown;

    const wf = defineWorkflow<Record<string, never>, string>({
      handler: async (ctx) => {
        try {
          const evt = await ctx.step.waitForEvent('hold', { type: 'release' });
          return evt.type;
        } catch (error) {
          caught = error;
          throw error;
        }
      },
    });

    const result = await harness.runToCompletion(wf, { params: {} });
    expect(result.status).toBe('suspended');
    expect(caught).toBeInstanceOf(WorkflowSuspended);
    expect((caught as WorkflowSuspended).waitName).toBe('hold');
    expect((caught as WorkflowSuspended).eventType).toBe('release');
  });
});
