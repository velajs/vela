import { Inject, Injectable, Optional } from '../container/index';
import { Container } from '../container/container';
import { InternalDispatcher } from '../dispatch/index';
import { resolveEntrypoint } from '../entrypoint/execution-context';
import { runInEntrypointScope } from '../entrypoint/execution-scope';
import type { Entrypoint } from '../entrypoint/entrypoint.types';
import { resolveErrorReporter } from '../exceptions/reporter';
import type {
  BeforeApplicationShutdown,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '../lifecycle/index';
import { parseCron } from '../schedule/cron-matcher';
import { ScheduleRegistry } from '../schedule/schedule.registry';
import { SCHEDULE_DISPATCH } from '../schedule/schedule.tokens';
import type {
  CronMetadata,
  IntervalMetadata,
  ScheduleDispatchMode,
  ScheduleInvocation,
  ScheduleJobRef,
} from '../schedule/schedule.types';

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
    const crons = this.#registry.getCronEntrypoints().map((entry) => {
      const matcher = parseCron(entry.meta.expression, entry.meta);
      if (!matcher)
        throw new TypeError(
          `Invalid cron expression for ${entry.meta.methodName}: ${entry.meta.expression}`,
        );
      return { entry, matcher, lastMinute: undefined as number | undefined };
    });
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

  #start(entry: Entrypoint<CronMetadata | IntervalMetadata>, scheduledTime: number): void {
    if (!this.#running) return;
    const controller = new AbortController();
    const meta = entry.meta;
    const tick: ScheduleInvocation =
      'expression' in meta
        ? { kind: 'cron', expression: meta.expression, scheduledTime, signal: controller.signal }
        : { kind: 'interval', ms: meta.ms, scheduledTime, signal: controller.signal };
    const job: ScheduleJobRef = { ...tick, methodName: meta.methodName };
    const pending = this.#invoke(entry, job, tick);
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

  async #invoke(entry: Entrypoint, job: ScheduleJobRef, tick: ScheduleInvocation): Promise<void> {
    try {
      if (this.#dispatch?.kind === 'signed') {
        if (!this.#dispatcher)
          throw new Error('Signed schedule dispatch requires InternalDispatcher.');
        await this.#dispatcher.run(this.#dispatch.target(job), {
          method: this.#dispatch.method,
          ttlSeconds: this.#dispatch.ttlSeconds,
          iss: `schedule:${job.methodName}`,
          signal: tick.signal,
        });
      } else {
        await runInEntrypointScope(
          this.#container,
          async (scope) => {
            const instance: unknown = await resolveEntrypoint(scope, entry);
            tick.signal.throwIfAborted();
            if (typeof instance !== 'object' || instance === null)
              throw new TypeError('Schedule provider must resolve to an object.');
            const method: unknown = Reflect.get(instance, job.methodName);
            if (typeof method !== 'function')
              throw new TypeError(`Scheduled method ${job.methodName} is not callable.`);
            await Reflect.apply(method, instance, [tick]);
          },
          { signal: tick.signal },
        );
      }
    } catch (error) {
      // A cooperative shutdown acknowledgement is not a failed job. Unrelated
      // errors remain reportable even when shutdown happened concurrently.
      if (tick.signal.aborted && error === tick.signal.reason) return;
      resolveErrorReporter(this.#container).report(error, {
        edge: 'schedule',
        source: job.methodName,
      });
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
