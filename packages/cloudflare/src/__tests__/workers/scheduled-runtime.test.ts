// @ts-expect-error virtual module supplied by @cloudflare/vitest-plugin
import * as cloudflareTest from 'cloudflare:test';
const { createExecutionContext, createScheduledController, waitOnExecutionContext } =
  cloudflareTest;
import { describe, expect, it } from 'vitest';
import { Inject, Injectable, InjectionToken, Module, Scope } from '@velajs/vela';
import { createCloudflareWorker } from '../../cloudflare-factory';
import {
  Scheduled,
  type ScheduledController,
  type ScheduledContext,
} from '../../decorators/scheduled';

const ENV = new InjectionToken<{ name: string }>('scheduled runtime env');

describe('native scheduled controller contract', () => {
  it('preserves controller receiver, binding identity and fresh scopes under workerd', async () => {
    const seen: Array<{ name: string; scope: object; time: number }> = [];
    @Injectable({ scope: Scope.REQUEST })
    class Job {
      constructor(@Inject(ENV) readonly env: { name: string }) {}
      @Scheduled('0 9 * * MON-FRI')
      run(controller: ScheduledController, _env: object, context: ScheduledContext) {
        controller.noRetry();
        context.waitUntil(
          Promise.resolve().then(() => {
            seen.push({ name: this.env.name, scope: this, time: controller.scheduledTime });
          }),
        );
      }
    }
    @Module({ providers: [Job] })
    class Root {}
    const worker = createCloudflareWorker(Root, { envToken: ENV });
    const event = createScheduledController({
      cron: '0 9 * * MON-FRI',
      scheduledTime: 1_704_703_200_000,
    });
    const context = createExecutionContext();
    const a = { name: 'a' };
    await Promise.all([
      worker.scheduled(event, a, context),
      worker.scheduled(event, { name: 'b' }, context),
    ]);
    await waitOnExecutionContext(context);
    expect(seen.map((entry) => entry.name).sort()).toEqual(['a', 'b']);
    expect(new Set(seen.map((entry) => entry.scope)).size).toBe(2);
    expect(seen.every((entry) => entry.time === event.scheduledTime)).toBe(true);
  });
});
