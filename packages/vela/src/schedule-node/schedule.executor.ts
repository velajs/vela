import { Inject, Injectable, Optional } from '../container/index';
import { Container } from '../container/container';
import { InternalDispatcher } from '../dispatch/index';
import { resolveErrorReporter } from '../exceptions/reporter';
import type { OnApplicationBootstrap, OnModuleDestroy } from '../lifecycle/index';
import { parseCron, type CronMatcher } from '../schedule/cron-matcher';
import { ScheduleRegistry } from '../schedule/schedule.registry';
import { SCHEDULE_DISPATCH } from '../schedule/schedule.tokens';
import type { ScheduleDispatchMode, ScheduleJobRef } from '../schedule/schedule.types';

@Injectable()
export class ScheduleExecutor implements OnApplicationBootstrap, OnModuleDestroy {
  private intervalTimers: ReturnType<typeof setInterval>[] = [];
  private cronTimers: ReturnType<typeof setInterval>[] = [];
  private cronMatcherCache = new Map<string, CronMatcher | null>();
  private lastCronMinute = new Map<string, number>();
  private running = true;

  constructor(
    private registry: ScheduleRegistry,
    @Inject(Container) private container: Container,
    @Optional() @Inject(SCHEDULE_DISPATCH) private readonly dispatch?: ScheduleDispatchMode,
    @Optional() @Inject(InternalDispatcher) private readonly dispatcher?: InternalDispatcher,
  ) {}

  onApplicationBootstrap(): void {
    if (typeof setInterval !== 'function') {
      throw new Error(
        '@velajs/vela/schedule-node requires Node or Bun. Use a platform cron adapter on edge runtimes (e.g. CloudflareApplication.scheduled).',
      );
    }

    for (const job of this.registry.getIntervalJobs()) {
      this.scheduleInterval(job.instance, job.methodName, job.ms);
    }

    const cronJobs = this.registry.getCronJobs();
    for (let i = 0; i < cronJobs.length; i++) {
      const job = cronJobs[i];
      this.scheduleCron(job!.instance, job!.methodName, job!.expression, i);
    }
  }

  private scheduleInterval(instance: unknown, methodName: string, ms: number): void {
    if (!this.running) return;

    const timer = setInterval(() => {
      void this.invoke(instance, { kind: 'interval', methodName, ms });
    }, ms);
    this.intervalTimers.push(timer);
  }

  private scheduleCron(
    instance: unknown,
    methodName: string,
    expression: string,
    index: number,
  ): void {
    if (!this.running) return;

    const matcher = this.getMatcher(expression);
    if (!matcher) return;

    const jobKey = `${index}:${methodName}:${expression}`;
    const timer = setInterval(() => {
      const now = new Date();
      const minuteKey = Math.floor(now.getTime() / 60_000);

      if (this.lastCronMinute.get(jobKey) === minuteKey) return;
      if (!matcher(now)) return;

      this.lastCronMinute.set(jobKey, minuteKey);
      void this.invoke(instance, { kind: 'cron', methodName, expression });
    }, 1000);

    this.cronTimers.push(timer);
  }

  private async invoke(instance: unknown, job: ScheduleJobRef): Promise<void> {
    try {
      if (this.dispatch?.kind === 'signed' && this.dispatcher) {
        // Opt-in signed re-entry: the fired job re-enters a user-authored
        // `@SignedInvocation()` route through `ctx.run`, running the full
        // request pipeline instead of a bare in-isolate method call. The
        // node/bun in-isolate transport (app.fetch) still verifies the claim.
        const dispatch = this.dispatch;
        await this.dispatcher.run(dispatch.target(job), {
          method: dispatch.method,
          ttlSeconds: dispatch.ttlSeconds,
          iss: `schedule:${job.methodName}`,
        });
      } else {
        const method = (instance as Record<string, Function>)[job.methodName];
        if (typeof method === 'function') {
          await method.call(instance);
        }
      }
    } catch (err) {
      // Report BEFORE the rethrow below — the exception handler sees every
      // scheduled-job error, and its default reporter logs it (unless silent),
      // replacing the previous bare console.warn.
      resolveErrorReporter(this.container).report(err, {
        edge: 'schedule',
        source: job.methodName,
      });
      // Runtime job error — keep the scheduler running by default. Users
      // can opt into rethrowing by setting diagnostics: 'throw'.
      const mode = this.container.getDiagnostics();
      if (mode === 'throw') throw err;
    }
  }

  private getMatcher(expression: string): CronMatcher | null {
    if (this.cronMatcherCache.has(expression)) {
      return this.cronMatcherCache.get(expression) ?? null;
    }
    const matcher = parseCron(expression);
    this.cronMatcherCache.set(expression, matcher);
    return matcher;
  }

  onModuleDestroy(): void {
    this.running = false;
    for (const timer of this.intervalTimers) clearInterval(timer);
    for (const timer of this.cronTimers) clearInterval(timer);
    this.intervalTimers = [];
    this.cronTimers = [];
    this.lastCronMinute.clear();
  }
}
