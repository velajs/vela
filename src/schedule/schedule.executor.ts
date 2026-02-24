import { Injectable } from '../container/index';
import type { OnApplicationBootstrap, OnModuleDestroy } from '../lifecycle/index';
import { ScheduleRegistry } from './schedule.registry';

@Injectable()
export class ScheduleExecutor implements OnApplicationBootstrap, OnModuleDestroy {
  private timers: ReturnType<typeof setTimeout>[] = [];
  private running = true;

  constructor(private registry: ScheduleRegistry) {}

  onApplicationBootstrap(): void {
    const jobs = this.registry.getIntervalJobs();

    for (const job of jobs) {
      this.scheduleNext(job.instance, job.methodName, job.ms);
    }
  }

  private scheduleNext(instance: unknown, methodName: string, ms: number): void {
    if (!this.running) return;

    const timer = setTimeout(async () => {
      try {
        const method = (instance as Record<string, Function>)[methodName];
        if (typeof method === 'function') {
          await method.call(instance);
        }
      } catch {
        // Swallow errors to keep the loop alive
      }
      this.scheduleNext(instance, methodName, ms);
    }, ms);

    this.timers.push(timer);
  }

  onModuleDestroy(): void {
    this.running = false;
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers = [];
  }
}
