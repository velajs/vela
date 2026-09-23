/**
 * `@velajs/studio/schedule` — the schedule panel binding.
 *
 * `ScheduleRegistry` lives in the REQUIRED `@velajs/vela` barrel (not an
 * optional peer), but the schedule ops still ship as an opt-in subpath so the
 * `schedule` feature only advertises `schedule.*` handlers when an app actually
 * wants the panel. An app imports `StudioScheduleModule` ALONGSIDE `StudioModule`
 * (and `ScheduleModule`); registration lights the `schedule` feature by
 * op-namespace (in UNION with the pre-existing `ScheduleRegistry`/
 * `SCHEDULE_DISPATCH` probe the M4 features service reads).
 *
 * Jobs are read from the app's `ScheduleRegistry` (public). HONEST DEGRADATION:
 * `RegisteredCronJob`/`RegisteredIntervalJob` carry no run timestamps, so
 * `ScheduleJobRow.lastRun`/`nextRun` and `CronTriggerRow.nextRun` are omitted
 * (the registry does not track fire history; a cron `nextRun` would need a clock
 * the registry has no hook into). `schedule.jobs` names each job by its
 * decorated `methodName`. `schedule.runNow` runs the job through
 * `invokeScheduledJob`, exactly as a timer or cron trigger would: a fresh
 * invocation scope (request-scoped jobs included), a `ScheduleInvocation` as the
 * only argument, and signed re-entry when the app opted into signed dispatch.
 */
import {
  Container,
  Inject,
  Injectable,
  ScheduleRegistry,
  defineModule,
  invokeScheduledJob,
} from '@velajs/vela';
import type { CronTriggerRow, ScheduleJobRow, StudioOpReq } from '@velajs/studio-protocol';
import { AdminRpc } from '../rpc/admin-rpc.decorator';
import type { AdminOpContext } from '../studio.types';
import { studioError, studioNotFound } from '../studio.errors';

export const STUDIO_SCHEDULE_MODULE_ID = 'studio.schedule';

@Injectable()
export class StudioScheduleOps {
  constructor(@Inject(Container) private readonly container: Container) {}

  @AdminRpc({ op: 'schedule.jobs' })
  jobs(_ctx: AdminOpContext): ScheduleJobRow[] {
    const registry = this.registry();
    const cron: ScheduleJobRow[] = registry
      .getCronJobs()
      .map((job) => ({ name: job.methodName, kind: 'cron', expression: job.expression }));
    const interval: ScheduleJobRow[] = registry
      .getIntervalJobs()
      .map((job) => ({ name: job.methodName, kind: 'interval', ms: job.ms }));
    return [...cron, ...interval];
  }

  @AdminRpc({ op: 'schedule.triggers' })
  triggers(_ctx: AdminOpContext): CronTriggerRow[] {
    return this.registry()
      .getCronJobs()
      .map((job) => ({ name: job.methodName, cron: job.expression }));
  }

  @AdminRpc({ op: 'schedule.runNow' })
  async runNow(ctx: AdminOpContext, args: StudioOpReq<'schedule.runNow'>): Promise<{ ok: true }> {
    const registry = this.registry();
    const cron = registry.getCronEntrypoints().find((e) => e.meta.methodName === args.id);
    const interval = cron
      ? undefined
      : registry.getIntervalEntrypoints().find((e) => e.meta.methodName === args.id);
    const scheduledTime = Date.now();
    const signal = new AbortController().signal;
    // Run through the same primitive a timer or cron trigger uses: a fresh
    // invocation scope, only a ScheduleInvocation argument, and signed
    // dispatch when ScheduleModule.forRoot({ dispatch }) opts in.
    if (cron) {
      await invokeScheduledJob(this.container, cron, {
        kind: 'cron',
        expression: cron.meta.expression,
        scheduledTime,
        signal,
      });
    } else if (interval) {
      await invokeScheduledJob(this.container, interval, {
        kind: 'interval',
        ms: interval.meta.ms,
        scheduledTime,
        signal,
      });
    } else {
      throw studioNotFound(`no scheduled job named '${args.id}'`);
    }
    ctx.audit({ target: args.id, summary: `ran scheduled job ${args.id}` });
    return { ok: true };
  }

  /** The bound `ScheduleRegistry`, else `FEATURE_UNCONFIGURED` (no `ScheduleModule`). */
  private registry(): ScheduleRegistry {
    if (!this.container.has(ScheduleRegistry)) {
      throw studioError('FEATURE_UNCONFIGURED', 'no ScheduleModule is wired');
    }
    return this.container.resolve(ScheduleRegistry);
  }
}

/** Options for {@link StudioScheduleModule}. Reserved for future schedule-panel wiring. */
export type StudioScheduleModuleOptions = Record<string, never>;

const { ConfigurableModuleClass } = defineModule<StudioScheduleModuleOptions>({
  name: 'StudioSchedule',
  setup: () => ({ providers: [StudioScheduleOps] }),
});

/**
 * Registers {@link StudioScheduleOps}. Import it with
 * `StudioScheduleModule.forRoot({})` ALONGSIDE `StudioModule` (and
 * `ScheduleModule`) in apps that want the schedule panel.
 */
export class StudioScheduleModule extends ConfigurableModuleClass {}
