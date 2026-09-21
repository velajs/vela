import type {
  ScheduledController as VelaController,
  ScheduledHandler,
} from '../decorators/scheduled';

/** Native Workers generated types and Vela's structural handler types compose directly. */
export function checkNativeController(
  controller: ScheduledController,
  handler: ScheduledHandler<{ name: string }>,
  ctx: ExecutionContext,
): void {
  const portable: VelaController = controller;
  void handler(controller, { name: 'worker' }, ctx);
  const worker: ExportedHandler<{ name: string }> = { scheduled: handler };
  // @ts-expect-error Native delivery requires the actual binding type.
  void handler(controller, { name: 42 }, ctx);
  // @ts-expect-error A production controller requires its scheduled time and noRetry method.
  const incomplete: VelaController = { cron: '* * * * *' };
  void [portable, worker, incomplete];
}
