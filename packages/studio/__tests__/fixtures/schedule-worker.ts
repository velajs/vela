import {
  EXECUTION_LIFETIME,
  Inject,
  Injectable,
  Module,
  Scope,
  type ExecutionLifetime,
} from '@velajs/vela';
import { Cron, ScheduleModule, type CronInvocation } from '@velajs/vela/schedule';
import {
  CLOUDFLARE_SCHEDULED_EVENT,
  createCloudflareWorker,
  type CloudflareScheduledEvent,
} from '@velajs/cloudflare';
import { StudioModule } from '../../src';
import { StudioScheduleModule } from '../../src/schedule';

// The documented Workers job: it reads the trigger event and extends its
// invocation. Studio's run-now must give it what a cron trigger would.
class Exports {
  constructor(
    private readonly trigger: CloudflareScheduledEvent,
    private readonly lifetime: ExecutionLifetime,
  ) {}

  async nightly(tick: CronInvocation): Promise<void> {
    if (this.trigger.cron !== tick.expression) throw new Error('trigger mismatch');
    this.trigger.noRetry();
    this.lifetime.waitUntil(Promise.resolve());
  }
}
Inject(CLOUDFLARE_SCHEDULED_EVENT)(Exports, undefined, 0);
Inject(EXECUTION_LIFETIME)(Exports, undefined, 1);
Injectable({ scope: Scope.REQUEST })(Exports);
Cron('30 2 * * *', { dialect: 'cloudflare' })(
  Exports.prototype,
  'nightly',
  Object.getOwnPropertyDescriptor(Exports.prototype, 'nightly')!,
);

class App {}
Module({
  imports: [
    StudioModule.forRoot({ editable: { ops: true } }),
    ScheduleModule,
    StudioScheduleModule.forRoot({}),
  ],
  providers: [Exports],
})(App);

export default createCloudflareWorker(App);
