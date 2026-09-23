const env = {};
import { describe, it, expect, beforeEach } from 'vitest';
import { Module, Injectable, MetadataRegistry } from '@velajs/vela';
import { createCloudflareApp } from '../cloudflare-factory';
import { Scheduled } from '../decorators/scheduled';
beforeEach(() => {
  MetadataRegistry.clear();
});

describe('@Scheduled() decorator', () => {
  it('should invoke matching cron handlers on scheduled event', async () => {
    const calls: string[] = [];

    @Injectable()
    class WorkerService {
      @Scheduled('0 * * * *')
      async hourlyCron() {
        calls.push('hourly');
      }

      @Scheduled('0 0 * * *')
      async dailyCron() {
        calls.push('daily');
      }
    }

    @Module({ providers: [WorkerService] })
    class AppModule {}

    const app = await createCloudflareApp(AppModule, { env });
    const ctx = { waitUntil: () => {} };

    // Trigger hourly cron
    await app.scheduled({ cron: '0 * * * *' }, env, ctx);
    expect(calls).toEqual(['hourly']);

    // Trigger daily cron
    await app.scheduled({ cron: '0 0 * * *' }, env, ctx);
    expect(calls).toEqual(['hourly', 'daily']);
  });

  it('should not invoke handlers when cron does not match', async () => {
    const calls: string[] = [];

    @Injectable()
    class CronService {
      @Scheduled('0 * * * *')
      async handler() {
        calls.push('invoked');
      }
    }

    @Module({ providers: [CronService] })
    class AppModule {}

    const app = await createCloudflareApp(AppModule, { env });
    const ctx = { waitUntil: () => {} };

    await app.scheduled({ cron: '*/5 * * * *' }, env, ctx);
    expect(calls).toEqual([]);
  });

  it('should handle multiple handlers for the same cron', async () => {
    const calls: string[] = [];

    @Injectable()
    class ServiceA {
      @Scheduled('0 * * * *')
      async handler() {
        calls.push('A');
      }
    }

    @Injectable()
    class ServiceB {
      @Scheduled('0 * * * *')
      async handler() {
        calls.push('B');
      }
    }

    @Module({ providers: [ServiceA, ServiceB] })
    class AppModule {}

    const app = await createCloudflareApp(AppModule, { env });
    const ctx = { waitUntil: () => {} };

    await app.scheduled({ cron: '0 * * * *' }, env, ctx);
    expect(calls).toContain('A');
    expect(calls).toContain('B');
    expect(calls.length).toBe(2);
  });
});
