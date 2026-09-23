import { Inject, Injectable, Optional } from '../container/index';
import { Container } from '../container/container';
import { InternalDispatcher } from '../dispatch/index';
import type { Entrypoint } from '../entrypoint/entrypoint.types';
import type {
  BeforeApplicationShutdown,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '../lifecycle/index';
import { parseCron } from '../schedule/cron-matcher';
import {
  cronDialectAmbiguity,
  reportScheduleDiagnostic,
  scheduledJobComponents,
  scheduledJobComponentsMessage,
  scheduledJobName,
} from '../schedule/schedule.diagnostics';
import { invokeScheduledJob } from '../schedule/schedule.invoke';
import { ScheduleRegistry } from '../schedule/schedule.registry';
import { SCHEDULE_DISPATCH } from '../schedule/schedule.tokens';
import type {
  CronMetadata,
  IntervalMetadata,
  ScheduleDispatchMode,
  ScheduleInvocation,
} from '../schedule/schedule.types';

/**
 * The process time zone when it is not UTC, else `undefined`. A zone whose
 * offset is zero in both January and July (UTC, Etc/GMT, Africa/Abidjan) runs
 * a local-time cron at the same instants as UTC.
 */
function nonUtcTimeZone(now = new Date()): string | undefined {
  const year = now.getFullYear();
  const offsets = [new Date(year, 0, 1), new Date(year, 6, 1)].map((date) =>
    date.getTimezoneOffset(),
  );
  if (offsets.every((offset) => offset === 0)) return undefined;
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
}

@Injectable()
export class ScheduleExecutor
  implements OnApplicationBootstrap, BeforeApplicationShutdown, OnModuleDestroy
{
  readonly #registry: ScheduleRegistry;
  readonly #container: Container;
  readonly #dispatch: ScheduleDispatchMode | undefined;
  readonly #dispatcher: InternalDispatcher | undefined;
  #timers: ReturnType<typeof setInterval>[] = [];
  readonly #active = new Map<Promise<void>, AbortController>();
  #running = true;
  #started = false;
  #shutdown: Promise<void> | undefined;
  #failure: { error: unknown } | undefined;

  constructor(
    @Inject(ScheduleRegistry) registry: ScheduleRegistry,
    @Inject(Container) container: Container,
    @Optional() @Inject(SCHEDULE_DISPATCH) dispatch?: ScheduleDispatchMode,
    @Optional() @Inject(InternalDispatcher) dispatcher?: InternalDispatcher,
  ) {
    this.#registry = registry;
    this.#container = container;
    this.#dispatch = dispatch;
    this.#dispatcher = dispatcher;
  }

  onApplicationBootstrap(): void {
    if (this.#started || !this.#running) return;
    if (typeof setInterval !== 'function') {
      throw new Error(
        '@velajs/vela/schedule-node requires Node or Bun. Use a platform cron adapter on edge runtimes.',
      );
    }
    if (this.#dispatch?.kind === 'signed' && !this.#dispatcher) {
      throw new Error('Signed schedule dispatch requires InternalDispatcher.');
    }
    // Validate the entire plan before creating any timer, including when a later
    // cron is malformed. Invalid configuration cannot leave background work alive.
    const intervals = this.#registry.getIntervalEntrypoints();
    const zone = nonUtcTimeZone();
    const crons = this.#registry.getCronEntrypoints().map((entry) => {
      const matcher = parseCron(entry.meta.expression, entry.meta);
      if (!matcher)
        throw new TypeError(
          `Invalid cron expression for ${entry.meta.methodName}: ${entry.meta.expression}`,
        );
      const cron = `@Cron('${entry.meta.expression}') on ${scheduledJobName(entry.token, entry.meta.methodName)}`;
      const ambiguity = cronDialectAmbiguity(entry.meta);
      if (ambiguity) {
        reportScheduleDiagnostic(
          this.#container,
          `[vela] ${cron} declares no dialect, and ${ambiguity}. Node runs it with Vela's ` +
            `unix dialect. For a job that also runs on Workers, declare ` +
            `{ dialect: 'cloudflare' } and write the expression for Cloudflare, so it fires on ` +
            `the same days on every runtime; declare { dialect: 'unix' } only for a Node-only job.`,
        );
      }
      if (
        zone !== undefined &&
        entry.meta.dialect === undefined &&
        entry.meta.timeZone === undefined
      ) {
        reportScheduleDiagnostic(
          this.#container,
          `[vela] ${cron} declares neither dialect nor timeZone, so Node runs it at local ` +
            `time (${zone}) while a Workers cron trigger runs it in UTC. Declare ` +
            `{ timeZone: 'UTC' } or { dialect: 'cloudflare' } so it fires at the same time on ` +
            `every runtime, or { timeZone: 'local' } to keep local time.`,
        );
      }
      this.#reportComponents(cron, entry);
      return { entry, matcher, lastMinute: undefined as number | undefined };
    });
    for (const entry of intervals) {
      this.#reportComponents(
        `@Interval(${entry.meta.ms}) on ${scheduledJobName(entry.token, entry.meta.methodName)}`,
        entry,
      );
    }
    this.#started = true;
    for (const entry of intervals) {
      this.#timers.push(setInterval(() => this.#start(entry, Date.now()), entry.meta.ms));
    }
    if (crons.length > 0) {
      this.#timers.push(
        setInterval(() => {
          const now = new Date();
          const minute = Math.floor(now.getTime() / 60_000);
          for (const job of crons) {
            if (job.lastMinute === minute || !job.matcher(now)) continue;
            job.lastMinute = minute;
            this.#start(job.entry, minute * 60_000);
          }
        }, 1000),
      );
    }
  }

  #reportComponents(label: string, entry: Entrypoint<CronMetadata | IntervalMetadata>): void {
    const decorators = scheduledJobComponents(this.#container, entry);
    if (decorators.length > 0) {
      reportScheduleDiagnostic(this.#container, scheduledJobComponentsMessage(label, decorators));
    }
  }

  #start(entry: Entrypoint<CronMetadata | IntervalMetadata>, scheduledTime: number): void {
    if (!this.#running) return;
    const controller = new AbortController();
    const meta = entry.meta;
    const tick: ScheduleInvocation =
      'expression' in meta
        ? { kind: 'cron', expression: meta.expression, scheduledTime, signal: controller.signal }
        : { kind: 'interval', ms: meta.ms, scheduledTime, signal: controller.signal };
    const pending = this.#invoke(entry, tick);
    this.#active.set(pending, controller);
    // Observe immediately; no detached rejection escapes a timer callback.
    void pending.then(
      () => {
        this.#active.delete(pending);
      },
      (error: unknown) => {
        this.#active.delete(pending);
        // diagnostics:throw has an awaitable failure boundary at shutdown. Keep
        // only its first failure and stop timers rather than growing a job log.
        this.#failure ??= { error };
        this.#stop();
      },
    );
  }

  async #invoke(
    entry: Entrypoint<CronMetadata | IntervalMetadata>,
    tick: ScheduleInvocation,
  ): Promise<void> {
    try {
      // Scope, signed dispatch and reporting are shared with every other runtime.
      await invokeScheduledJob(this.#container, entry, tick);
    } catch (error) {
      // Already reported; timers keep running unless diagnostics are strict.
      if (this.#container.getDiagnostics() === 'throw') throw error;
    }
  }

  #stop(): void {
    this.#running = false;
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers = [];
    for (const controller of this.#active.values()) controller.abort();
  }

  /** Stop and drain before providers' onModuleDestroy hooks release their resources. */
  beforeApplicationShutdown(): Promise<void> {
    return this.onModuleDestroy();
  }

  onModuleDestroy(): Promise<void> {
    this.#stop();
    this.#shutdown ??= (async () => {
      await Promise.allSettled(this.#active.keys());
      if (this.#failure) throw this.#failure.error;
    })();
    return this.#shutdown;
  }
}
