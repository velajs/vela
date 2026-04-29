import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VelaFactory, Module, Injectable, MetadataRegistry } from '../index.js';
import { ScheduleModule, ScheduleRegistry, Cron, Interval, parseCron } from '../schedule/index.js';
import { ScheduleNodeModule, ScheduleExecutor } from '../schedule-node/index.js';

beforeEach(() => { MetadataRegistry.clear(); });

describe('ScheduleModule', () => {
  describe('@Cron decorator', () => {
    it('should store cron metadata', () => {
      @Injectable()
      class TaskService {
        @Cron('0 * * * *')
        handleCron() {}

        @Cron('*/5 * * * *')
        handleFrequentCron() {}
      }

      const metadata = Reflect.getMetadata('vela:cron', TaskService);
      expect(metadata).toEqual([
        { expression: '0 * * * *', methodName: 'handleCron' },
        { expression: '*/5 * * * *', methodName: 'handleFrequentCron' },
      ]);
    });
  });

  describe('@Interval decorator', () => {
    it('should store interval metadata', () => {
      @Injectable()
      class TaskService {
        @Interval(1000)
        handleInterval() {}

        @Interval(5000)
        handleSlowInterval() {}
      }

      const metadata = Reflect.getMetadata('vela:interval', TaskService);
      expect(metadata).toEqual([
        { ms: 1000, methodName: 'handleInterval' },
        { ms: 5000, methodName: 'handleSlowInterval' },
      ]);
    });
  });

  describe('ScheduleRegistry', () => {
    it('should discover @Cron jobs after bootstrap', async () => {
      @Injectable()
      class TaskService {
        @Cron('0 * * * *')
        runHourly() {}
      }

      @Module({
        imports: [ScheduleModule.forRoot()],
        providers: [TaskService],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const registry = app.get(ScheduleRegistry);

      const cronJobs = registry.getCronJobs();
      expect(cronJobs).toHaveLength(1);
      expect(cronJobs[0].expression).toBe('0 * * * *');
      expect(cronJobs[0].methodName).toBe('runHourly');
    });

    it('should discover @Interval jobs after bootstrap', async () => {
      @Injectable()
      class TaskService {
        @Interval(5000)
        runEvery5s() {}
      }

      @Module({
        imports: [ScheduleModule.forRoot()],
        providers: [TaskService],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const registry = app.get(ScheduleRegistry);

      const intervalJobs = registry.getIntervalJobs();
      expect(intervalJobs).toHaveLength(1);
      expect(intervalJobs[0].ms).toBe(5000);
      expect(intervalJobs[0].methodName).toBe('runEvery5s');
    });

    it('should discover multiple decorators on same class', async () => {
      @Injectable()
      class MultiTaskService {
        @Cron('0 * * * *')
        hourly() {}

        @Cron('0 0 * * *')
        daily() {}

        @Interval(1000)
        frequent() {}
      }

      @Module({
        imports: [ScheduleModule.forRoot()],
        providers: [MultiTaskService],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const registry = app.get(ScheduleRegistry);

      expect(registry.getCronJobs()).toHaveLength(2);
      expect(registry.getIntervalJobs()).toHaveLength(1);
    });

    it('should not include the executor on the core module', async () => {
      @Injectable()
      class TaskService {
        @Interval(100)
        tick() {}
      }

      @Module({
        imports: [ScheduleModule.forRoot()],
        providers: [TaskService],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      expect(app.getContainer().has(ScheduleExecutor)).toBe(false);
    });
  });

  describe('parseCron', () => {
    it('matches "* * * * *" against any minute', () => {
      const matcher = parseCron('* * * * *');
      expect(matcher).not.toBeNull();
      expect(matcher!(new Date('2024-01-01T00:00:00Z'))).toBe(true);
    });

    it('returns null for malformed expressions', () => {
      expect(parseCron('not-a-cron')).toBeNull();
      expect(parseCron('* * *')).toBeNull();
    });

    it('treats 7 as Sunday', () => {
      const matcher = parseCron('0 0 * * 7');
      // Local Sunday — getDay() returns 0; the cron lib must accept 7 as the same.
      expect(matcher!(new Date(2024, 0, 7, 0, 0, 0))).toBe(true);
    });
  });
});

describe('ScheduleNodeModule', () => {
  it('should run cron jobs when expression matches the current minute', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    let callCount = 0;

    @Injectable()
    class CronService {
      @Cron('* * * * *')
      tick() { callCount++; }
    }

    @Module({
      imports: [ScheduleNodeModule.forRoot()],
      providers: [CronService],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);

    // One call in the 00:00 minute and one in the 00:01 minute
    await vi.advanceTimersByTimeAsync(61_000);
    expect(callCount).toBe(2);

    await app.close();
    vi.useRealTimers();
  });

  it('should run interval jobs', async () => {
    vi.useFakeTimers();
    let callCount = 0;

    @Injectable()
    class TimerService {
      @Interval(100)
      tick() { callCount++; }
    }

    @Module({
      imports: [ScheduleNodeModule.forRoot()],
      providers: [TimerService],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);

    await vi.advanceTimersByTimeAsync(350);
    expect(callCount).toBe(3);

    await app.close();
    vi.useRealTimers();
  });

  it('should cleanup timers on app.close()', async () => {
    vi.useFakeTimers();
    let callCount = 0;

    @Injectable()
    class TimerService {
      @Interval(100)
      tick() { callCount++; }
    }

    @Module({
      imports: [ScheduleNodeModule.forRoot()],
      providers: [TimerService],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await vi.advanceTimersByTimeAsync(150);
    const countBeforeClose = callCount;

    await app.close();

    await vi.advanceTimersByTimeAsync(500);
    expect(callCount).toBe(countBeforeClose);

    vi.useRealTimers();
  });
});
