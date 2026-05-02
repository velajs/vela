import { Injectable, Inject } from '../container/index';
import { Container } from '../container/container';
import type { OnApplicationBootstrap } from '../lifecycle/index';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor } from '../registry/types';
import { CRON_METADATA, INTERVAL_METADATA } from './schedule.tokens';
import type { CronMetadata, IntervalMetadata } from './schedule.types';

export interface RegisteredCronJob {
  expression: string;
  methodName: string;
  instance: unknown;
  target: Function;
}

export interface RegisteredIntervalJob {
  ms: number;
  methodName: string;
  instance: unknown;
  target: Function;
}

@Injectable()
export class ScheduleRegistry implements OnApplicationBootstrap {
  private cronJobs: RegisteredCronJob[] = [];
  private intervalJobs: RegisteredIntervalJob[] = [];

  constructor(@Inject(Container) private container: Container) {}

  onApplicationBootstrap(): void {
    const tokens = this.container.getTokens();

    for (const token of tokens) {
      if (typeof token !== 'function') continue;

      const cronMeta = MetadataRegistry.getCustomClassMeta(token as Constructor, CRON_METADATA) as
        | CronMetadata[]
        | undefined;
      const intervalMeta = MetadataRegistry.getCustomClassMeta(token as Constructor, INTERVAL_METADATA) as
        | IntervalMetadata[]
        | undefined;

      if (!cronMeta && !intervalMeta) continue;

      let instance: unknown;
      try {
        instance = this.container.resolve(token);
      } catch (err) {
        const mode = this.container.getDiagnostics();
        if (mode === 'throw') throw err;
        if (mode === 'log') {
          console.warn(
            `[vela] schedule discovery: cannot resolve ${(token as Function).name ?? String(token)}:`,
            err,
          );
        }
        continue;
      }

      if (cronMeta) {
        for (const { expression, methodName } of cronMeta) {
          this.cronJobs.push({ expression, methodName, instance, target: token });
        }
      }

      if (intervalMeta) {
        for (const { ms, methodName } of intervalMeta) {
          this.intervalJobs.push({ ms, methodName, instance, target: token });
        }
      }
    }
  }

  getCronJobs(): RegisteredCronJob[] {
    return [...this.cronJobs];
  }

  getIntervalJobs(): RegisteredIntervalJob[] {
    return [...this.intervalJobs];
  }
}
