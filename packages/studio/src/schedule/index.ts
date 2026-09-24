/**
 * `@velajs/studio/schedule` — the schedule panel binding.
 *
 * `ScheduleRegistry` lives in the REQUIRED `@velajs/vela` barrel (not an
 * optional peer), but the schedule ops still ship as an opt-in subpath so the
 * `schedule` feature only advertises `schedule.*` handlers when an app actually
 * wants the panel. An app adds `schedulePanel()` to
 * `StudioModule.forRoot({ plugins })` (with `ScheduleModule`); registration
 * lights the `schedule` feature by
 * op-namespace (in UNION with the pre-existing `ScheduleRegistry`/
 * `SCHEDULE_DISPATCH` probe the M4 features service reads).
 *
 * Jobs are read from the app's `ScheduleRegistry` (public) through its
 * metadata-only entrypoints, the same descriptors `schedule.runNow` executes:
 * request-scoped jobs and jobs in lazy modules are listed without being
 * materialized. HONEST DEGRADATION: the entrypoints carry no run timestamps,
 * so `ScheduleJobRow.lastRun`/`nextRun` and `CronTriggerRow.nextRun` are
 * omitted (the registry does not track fire history; a cron `nextRun` would
 * need a clock the registry has no hook into). `schedule.jobs` names each job
 * by its decorated `methodName`. `schedule.runNow` runs the job through
 * `invokeScheduledJob`, like a timer or cron trigger: a fresh invocation scope
 * (request-scoped jobs included), a `ScheduleInvocation` as the only argument
 * (`scheduledTime` is now), and signed re-entry when the app opted into signed
 * dispatch. A direct job that declares guards is refused, as on a trigger, and
 * the refusal is returned to the caller. What a native trigger would seed into the job's scope comes from
 * the runtime's `SCHEDULE_INVOCATION_SEED` (on Workers, a synthetic
 * `CLOUDFLARE_SCHEDULED_EVENT` whose `noRetry()` does nothing). Closing the
 * application aborts the signal of a run still in progress and waits for it.
 */
import { Inject, Injectable } from '@velajs/vela';
import { defineStudioPlugin, type StudioPlugin } from '../plugin';
import { Container, SCHEDULE_INVOCATION_SEED, invokeScheduledJob } from '@velajs/vela/module-kit';
import { ScheduleRegistry } from '@velajs/vela/schedule';
import type { BeforeApplicationShutdown } from '@velajs/vela';
import type { CronMetadata, IntervalMetadata, ScheduleInvocation } from '@velajs/vela/schedule';
import type { Entrypoint, InvokeScheduledJobOptions } from '@velajs/vela/module-kit';
import type { CronTriggerRow, ScheduleJobRow, StudioOpReq } from '@velajs/studio-protocol';
import { AdminRpc } from '../rpc/admin-rpc.decorator';
import type { AdminOpContext } from '../studio.types';
import { studioError, studioNotFound } from '../studio.errors';


@Injectable()
export class StudioScheduleOps implements BeforeApplicationShutdown {
  /** Runs in progress; shutdown aborts their signals and waits for them. */
  readonly #running = new Map<Promise<void>, AbortController>();

  constructor(@Inject(Container) private readonly container: Container) {}

  @AdminRpc({ op: 'schedule.jobs' })
  jobs(_ctx: AdminOpContext): ScheduleJobRow[] {
    const registry = this.registry();
    const cron: ScheduleJobRow[] = registry
      .getCronEntrypoints()
      .map(({ meta }) => ({ name: meta.methodName, kind: 'cron', expression: meta.expression }));
    const interval: ScheduleJobRow[] = registry
      .getIntervalEntrypoints()
      .map(({ meta }) => ({ name: meta.methodName, kind: 'interval', ms: meta.ms }));
    return [...cron, ...interval];
  }

  @AdminRpc({ op: 'schedule.triggers' })
  triggers(_ctx: AdminOpContext): CronTriggerRow[] {
    return this.registry()
      .getCronEntrypoints()
      .map(({ meta }) => ({ name: meta.methodName, cron: meta.expression }));
  }

  @AdminRpc({ op: 'schedule.runNow' })
  async runNow(ctx: AdminOpContext, args: StudioOpReq<'schedule.runNow'>): Promise<{ ok: true }> {
    const registry = this.registry();
    const cron = registry.getCronEntrypoints().find((e) => e.meta.methodName === args.id);
    const interval = cron
      ? undefined
      : registry.getIntervalEntrypoints().find((e) => e.meta.methodName === args.id);
    const controller = new AbortController();
    const scheduledTime = Date.now();
    let entry: Entrypoint<CronMetadata | IntervalMetadata>;
    let invocation: ScheduleInvocation;
    if (cron) {
      entry = cron;
      invocation = {
        kind: 'cron',
        expression: cron.meta.expression,
        scheduledTime,
        signal: controller.signal,
      };
    } else if (interval) {
      entry = interval;
      invocation = {
        kind: 'interval',
        ms: interval.meta.ms,
        scheduledTime,
        signal: controller.signal,
      };
    } else {
      throw studioNotFound(`no scheduled job named '${args.id}'`);
    }
    // Run through the same primitive a timer or cron trigger uses, seeded the
    // way the runtime's trigger would seed it.
    const running = invokeScheduledJob(this.container, entry, invocation, this.seed(invocation));
    this.#running.set(running, controller);
    try {
      await running;
    } finally {
      this.#running.delete(running);
    }
    ctx.audit({ target: args.id, summary: `ran scheduled job ${args.id}` });
    return { ok: true };
  }

  /** Abort the runs still in progress and wait for them before providers shut down. */
  async beforeApplicationShutdown(): Promise<void> {
    for (const controller of this.#running.values()) controller.abort();
    await Promise.allSettled(this.#running.keys());
  }

  private seed(invocation: ScheduleInvocation): InvokeScheduledJobOptions {
    if (!this.container.has(SCHEDULE_INVOCATION_SEED)) return {};
    const seed = this.container.resolve(SCHEDULE_INVOCATION_SEED);
    return { seed: (scope) => seed(scope, invocation) };
  }

  /** The bound `ScheduleRegistry`, else `FEATURE_UNCONFIGURED` (no `ScheduleModule`). */
  private registry(): ScheduleRegistry {
    if (!this.container.has(ScheduleRegistry)) {
      throw studioError('FEATURE_UNCONFIGURED', 'no ScheduleModule is wired');
    }
    return this.container.resolve(ScheduleRegistry);
  }
}

/**
 * The schedule panel: registers {@link StudioScheduleOps}, lighting the
 * `schedule` feature in apps with `ScheduleModule`:
 * `StudioModule.forRoot({ plugins: [schedulePanel()] })`.
 */
export function schedulePanel(): StudioPlugin {
  return defineStudioPlugin({ name: 'schedule', providers: [StudioScheduleOps] });
}
