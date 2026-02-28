import { Injectable } from '../container/index';
import type { OnApplicationBootstrap, OnModuleDestroy } from '../lifecycle/index';
import { ScheduleRegistry } from './schedule.registry';

type CronMatcher = (date: Date) => boolean;

@Injectable()
export class ScheduleExecutor implements OnApplicationBootstrap, OnModuleDestroy {
  private intervalTimers: ReturnType<typeof setInterval>[] = [];
  private cronTimers: ReturnType<typeof setInterval>[] = [];
  private cronMatcherCache = new Map<string, CronMatcher | null>();
  private lastCronMinute = new Map<string, number>();
  private running = true;

  constructor(private registry: ScheduleRegistry) {}

  onApplicationBootstrap(): void {
    const intervalJobs = this.registry.getIntervalJobs();
    const cronJobs = this.registry.getCronJobs();

    for (const job of intervalJobs) {
      this.scheduleInterval(job.instance, job.methodName, job.ms);
    }

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

  private scheduleCron(
    instance: unknown,
    methodName: string,
    expression: string,
    index: number,
  ): void {
    if (!this.running) return;

    const matcher = this.getCronMatcher(expression);
    if (!matcher) {
      return;
    }

    const jobKey = `${index}:${methodName}:${expression}`;
    const timer = setInterval(() => {
      const now = new Date();
      const minuteKey = Math.floor(now.getTime() / 60_000);

      if (this.lastCronMinute.get(jobKey) === minuteKey) {
        return;
      }

      if (!matcher(now)) {
        return;
      }

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
      // Swallow errors to keep the scheduler alive
    }
  }

  private getCronMatcher(expression: string): CronMatcher | null {
    if (this.cronMatcherCache.has(expression)) {
      return this.cronMatcherCache.get(expression) ?? null;
    }

    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) {
      this.cronMatcherCache.set(expression, null);
      return null;
    }

    const [minuteField, hourField, dayField, monthField, weekdayField] = fields;

    const minuteMatcher = this.parseField(minuteField, 0, 59);
    const hourMatcher = this.parseField(hourField, 0, 23);
    const dayMatcher = this.parseField(dayField, 1, 31);
    const monthMatcher = this.parseField(monthField, 1, 12);
    const weekdayMatcher = this.parseField(weekdayField, 0, 7);

    if (!minuteMatcher || !hourMatcher || !dayMatcher || !monthMatcher || !weekdayMatcher) {
      this.cronMatcherCache.set(expression, null);
      return null;
    }

    const matcher: CronMatcher = (date: Date) => {
      const weekday = date.getDay();
      return (
        minuteMatcher(date.getMinutes()) &&
        hourMatcher(date.getHours()) &&
        dayMatcher(date.getDate()) &&
        monthMatcher(date.getMonth() + 1) &&
        weekdayMatcher(weekday)
      );
    };

    this.cronMatcherCache.set(expression, matcher);
    return matcher;
  }

  private parseField(field: string, min: number, max: number): ((value: number) => boolean) | null {
    const segments = field.split(',');
    const predicates: Array<(value: number) => boolean> = [];

    for (const rawSegment of segments) {
      const segment = rawSegment.trim();
      if (!segment) return null;

      const stepParts = segment.split('/');
      if (stepParts.length > 2) return null;

      const baseSegment = stepParts[0];
      const step = stepParts.length === 2 ? Number(stepParts[1]) : 1;
      if (!Number.isInteger(step) || step <= 0) return null;

      const range = this.parseRange(baseSegment, min, max);
      if (!range) return null;

      predicates.push((value: number) => {
        if (value < range.start || value > range.end) return false;
        return (value - range.start) % step === 0;
      });
    }

    return (value: number) => predicates.some((predicate) => predicate(value));
  }

  private parseRange(segment: string, min: number, max: number): { start: number; end: number } | null {
    if (segment === '*') {
      return { start: min, end: max };
    }

    const bounds = segment.split('-');
    if (bounds.length === 1) {
      const value = this.parseCronNumber(bounds[0], min, max);
      if (value === null) return null;
      return { start: value, end: value };
    }

    if (bounds.length !== 2) return null;
    const start = this.parseCronNumber(bounds[0], min, max);
    const end = this.parseCronNumber(bounds[1], min, max);
    if (start === null || end === null || start > end) return null;
    return { start, end };
  }

  private parseCronNumber(raw: string, min: number, max: number): number | null {
    const value = Number(raw);
    if (!Number.isInteger(value)) return null;

    // Cron allows both 0 and 7 for Sunday.
    const normalized = max === 7 && value === 7 ? 0 : value;
    if (normalized < min || normalized > max) return null;
    return normalized;
  }

  onModuleDestroy(): void {
    this.running = false;
    for (const timer of this.intervalTimers) {
      clearInterval(timer);
    }
    for (const timer of this.cronTimers) {
      clearInterval(timer);
    }
    this.intervalTimers = [];
    this.cronTimers = [];
    this.lastCronMinute.clear();
  }
}
