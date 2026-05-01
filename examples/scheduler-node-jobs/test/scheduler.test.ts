import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScheduleExecutor } from '@velajs/vela/schedule-node';
import { createSchedulerNodeJobsApp } from '../src/app.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('Scheduler Node Jobs consumer project', () => {
  it('registers interval and cron jobs and exposes the Node executor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    const { app } = await createSchedulerNodeJobsApp({
      intervalMs: 100,
      cronExpression: '* * * * *',
    });
    const hono = app.getHonoApp();

    const registry = await hono.request('/jobs/registry');
    expect(registry.status).toBe(200);
    expect(await registry.json()).toEqual({
      hasExecutor: true,
      intervalJobs: [{ methodName: 'pulse', ms: 100 }],
      cronJobs: [{ methodName: 'minute', expression: '* * * * *' }],
    });

    expect(app.get(ScheduleExecutor)).toBeInstanceOf(ScheduleExecutor);

    await app.close('registry-test-complete');
  });

  it('runs interval jobs and cron jobs with controlled timers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    const { app, state } = await createSchedulerNodeJobsApp({
      intervalMs: 100,
      cronExpression: '* * * * *',
    });

    await vi.advanceTimersByTimeAsync(350);
    expect(state.intervalTicks).toBe(3);
    expect(state.cronTicks).toBe(0);

    await vi.advanceTimersByTimeAsync(650);
    expect(state.cronTicks).toBe(1);

    await vi.advanceTimersByTimeAsync(61_000);
    expect(state.cronTicks).toBe(2);

    const countBeforeClose = state.intervalTicks;
    await app.close('timer-test-complete');
    await vi.advanceTimersByTimeAsync(500);
    expect(state.intervalTicks).toBe(countBeforeClose);
  });
});
