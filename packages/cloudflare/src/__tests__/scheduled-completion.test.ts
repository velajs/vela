import { describe, expect, it, vi } from 'vitest';
import { Injectable, Module, Scope } from '@velajs/vela';
import { createCloudflareApp } from '../cloudflare-factory';
import { Scheduled, type ScheduledContext } from '../decorators/scheduled';

describe('whole scheduled trigger completion', () => {
  it('awaits slow siblings and their disposal after an early failure', async () => {
    const hold = Promise.withResolvers<void>();
    const events: string[] = [];
    const failure = new Error('first failure');
    @Injectable({ scope: Scope.REQUEST })
    class Fast {
      @Scheduled('* * * * *') run() {
        events.push('fast');
        throw failure;
      }
      dispose() {
        events.push('fast disposed');
      }
    }
    @Injectable({ scope: Scope.REQUEST })
    class Slow {
      @Scheduled('* * * * *') async run() {
        events.push('slow');
        await hold.promise;
      }
      dispose() {
        events.push('slow disposed');
      }
    }
    @Module({ providers: [Fast, Slow] })
    class Root {}
    const env = {};
    const app = await createCloudflareApp(Root, { env });
    let settled = false;
    const done = app.scheduled({ cron: '* * * * *' }, env, { waitUntil() {} }).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await vi.waitFor(() => expect(events).toContain('fast disposed'));
      expect(events).toContain('slow');
      expect(settled).toBe(false);
      hold.resolve();
      expect(await done).toBe(failure);
      expect(events).toContain('slow disposed');
    } finally {
      hold.resolve();
      await done;
      await app.close();
    }
  });

  it('preserves every handler failure in an aggregate', async () => {
    const failures = [new Error('a'), new Error('b')];
    @Injectable()
    class Jobs {
      @Scheduled('* * * * *') a() {
        throw failures[0];
      }
      @Scheduled('* * * * *') b() {
        throw failures[1];
      }
    }
    @Module({ providers: [Jobs] })
    class Root {}
    const env = {};
    const app = await createCloudflareApp(Root, { env });
    try {
      await expect(
        app.scheduled({ cron: '* * * * *' }, env, { waitUntil() {} }),
      ).rejects.toMatchObject({ errors: failures });
    } finally {
      await app.close();
    }
  });

  it('retains request resources until scheduled waitUntil work finishes', async () => {
    const hold = Promise.withResolvers<void>();
    const events: string[] = [];
    const platformWaitUntil = vi.fn();
    @Injectable({ scope: Scope.REQUEST })
    class Job {
      @Scheduled('* * * * *') run(_event: unknown, _env: object, context: ScheduledContext) {
        context.waitUntil(
          hold.promise.then(() => {
            events.push('background');
          }),
        );
        events.push('handler');
      }
      dispose() {
        events.push('disposed');
      }
    }
    @Module({ providers: [Job] })
    class Root {}
    const env = {};
    const app = await createCloudflareApp(Root, { env });
    const done = app.scheduled({ cron: '* * * * *' }, env, { waitUntil: platformWaitUntil });
    try {
      await vi.waitFor(() => expect(events).toContain('handler'));
      expect(events).toEqual(['handler']);
      expect(platformWaitUntil).toHaveBeenCalledOnce();
      hold.resolve();
      await done;
      expect(events).toEqual(['handler', 'background', 'disposed']);
    } finally {
      hold.resolve();
      await done;
      await app.close();
    }
  });
});
