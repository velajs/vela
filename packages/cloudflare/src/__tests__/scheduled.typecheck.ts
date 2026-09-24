import type { InjectionToken, VelaEnv } from '@velajs/vela';
import { Cron, type ScheduleInvocation } from '@velajs/vela/schedule';
import type { createCloudflareWorker } from '../cloudflare-factory';
import type { CloudflareApplication } from '../cloudflare-application';
import {
  CLOUDFLARE_SCHEDULED_EVENT,
  type CloudflareScheduledEvent,
  type ScheduledEvent,
} from '../scheduled-event';

/** The native Workers controller and handler types compose with the adapter directly. */
export function checkNativeController(
  controller: ScheduledController,
  ctx: ExecutionContext,
  app: CloudflareApplication,
  worker: ReturnType<typeof createCloudflareWorker>,
): void {
  const event: ScheduledEvent = controller;
  void app.scheduled(controller, {}, ctx);
  const handler: ExportedHandler<VelaEnv>['scheduled'] = worker.scheduled;
  // Direct calls may omit the scheduled time and noRetry.
  void app.scheduled({ cron: '* * * * *' }, {}, ctx);
  // @ts-expect-error The trigger string is required.
  void app.scheduled({ scheduledTime: 0 }, {}, ctx);

  const token: InjectionToken<CloudflareScheduledEvent> = CLOUDFLARE_SCHEDULED_EVENT;
  const injected: CloudflareScheduledEvent = {
    cron: controller.cron,
    scheduledTime: controller.scheduledTime,
    noRetry: () => controller.noRetry(),
  };
  // @ts-expect-error The injected event always carries the platform scheduled time.
  const partial: CloudflareScheduledEvent = { cron: '* * * * *', noRetry() {} };

  // @ts-expect-error The portable invocation carries no platform fields.
  void ((tick: ScheduleInvocation) => tick.noRetry);
  void [event, handler, token, injected, partial];
}

/** Workers cron jobs receive the portable invocation, never the native handler arguments. */
export class NativeHandlerSignatures {
  // @ts-expect-error The native (controller, env, ctx) arguments are gone; inject what the job needs.
  @Cron('0 3 * * *', { dialect: 'cloudflare' })
  nightly(controller: ScheduledController, env: VelaEnv, ctx: ExecutionContext): void {
    void [controller, env, ctx];
  }

  // @ts-expect-error The native controller is not the invocation.
  @Cron('0 4 * * *', { dialect: 'cloudflare' })
  controllerOnly(controller: ScheduledController): void {
    void controller;
  }
}
