import { describe, expect, it } from 'vitest';

import { createWorkflowLogger, createWorkflowRunContext } from '../index';
import type { WorkflowEventLike } from '../index';
import { immediateStep, recordingRun, rejectingRun } from './support';

const event = (payload: { orderId: string }): WorkflowEventLike<{ orderId: string }> => ({
  instanceId: 'inst-1',
  payload,
  timestamp: new Date(0),
  workflowName: 'order-pipeline',
});

describe('createWorkflowRunContext', () => {
  it('assembles env, event, params, step, run, runStep, and log', () => {
    const step = immediateStep();
    const ctx = createWorkflowRunContext({
      env: { KV: 'binding' },
      event: event({ orderId: 'o-1' }),
      exportName: 'orderPipeline',
      run: rejectingRun,
      step,
    });

    expect(ctx.env).toEqual({ KV: 'binding' });
    expect(ctx.event.instanceId).toBe('inst-1');
    expect(ctx.params).toEqual({ orderId: 'o-1' });
    expect(ctx.step).toBe(step);
    expect(ctx.run).toBe(rejectingRun);
    expect(typeof ctx.runStep).toBe('function');
    expect(ctx.log).toBeDefined();
  });

  it('injects run verbatim — the seam forwards the exact target/init', async () => {
    const { run, calls } = recordingRun();
    const ctx = createWorkflowRunContext({
      env: {},
      event: event({ orderId: 'o-2' }),
      exportName: 'orderPipeline',
      run,
      step: immediateStep(),
    });

    await expect(
      ctx.run({ route: 'payments.charge', params: { id: '7' } }, { body: { amount: 5 } }),
    ).rejects.toThrow(/no result configured/);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.target).toEqual({ route: 'payments.charge', params: { id: '7' } });
    expect(calls[0]?.init).toEqual({ body: { amount: 5 } });
  });
});

describe('createWorkflowLogger', () => {
  it('stamps every level with the prefix', () => {
    const lines: string[] = [];
    const original = {
      debug: console.debug,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };
    console.debug = (...a: unknown[]) => lines.push(String(a[0]));
    console.info = (...a: unknown[]) => lines.push(String(a[0]));
    console.warn = (...a: unknown[]) => lines.push(String(a[0]));
    console.error = (...a: unknown[]) => lines.push(String(a[0]));

    try {
      const log = createWorkflowLogger('[workflow:test]');
      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');
    } finally {
      Object.assign(console, original);
    }

    expect(lines).toEqual([
      '[workflow:test] d',
      '[workflow:test] i',
      '[workflow:test] w',
      '[workflow:test] e',
    ]);
  });
});
