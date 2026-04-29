import { Injectable } from '../container/index';
import type { OnApplicationBootstrap, OnModuleDestroy } from '../lifecycle/index';
import { parseCron, type CronMatcher } from '../schedule/cron-matcher';
import { ScheduleRegistry } from '../schedule/schedule.registry';

@Injectable()
export class ScheduleExecutor implements OnApplicationBootstrap, OnModuleDestroy {
  private intervalTimers: ReturnType<typeof setInterval>[] = [];
  private cronTimers: ReturnType<typeof setInterval>[] = [];
  private cronMatcherCache = new Map<string, CronMatcher | null>();
  private lastCronMinute = new Map<string, number>();
  private running = true;

  constructor(private registry: ScheduleRegistry) {}

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
      this.scheduleCron(job.instance, job.methodName, job.expression, i);
    }
  }

  private scheduleInterval(instance: unknown, methodName: string, ms: number): void {
    if (!this.running) return;

    const timer = setInterval(() => {
      void this.invoke(instance, methodName);
    }, ms);
    this.intervalTimers.push(timer);
  }

  private scheduleCron(instance: unknown, methodName: string, expression: string, index: number): void {
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
      void this.invoke(instance, methodName);
    }, 1000);

    this.cronTimers.push(timer);
  }

  private async invoke(instance: unknown, methodName: string): Promise<void> {
    try {
      const method = (instance as Record<string, Function>)[methodName];
      if (typeof method === 'function') {
        await method.call(instance);
      }
    } catch {
      // Swallow errors so the scheduler keeps running
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
