import { Injectable, Inject } from '../container/index';
import { DiscoveryService } from '../discovery/discovery.service';
import type { OnApplicationBootstrap } from '../lifecycle/index';
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

  constructor(@Inject(DiscoveryService) private readonly discovery: DiscoveryService) {}

  onApplicationBootstrap(): void {
    for (const found of this.discovery.methodsWithMeta<CronMetadata>(CRON_METADATA)) {
      if (!found.class.instance) continue;
      this.cronJobs.push({
        expression: found.meta.expression,
        methodName: String(found.methodName),
        instance: found.class.instance,
        target: found.class.metatype,
      });
    }

    for (const found of this.discovery.methodsWithMeta<IntervalMetadata>(INTERVAL_METADATA)) {
      if (!found.class.instance) continue;
      this.intervalJobs.push({
        ms: found.meta.ms,
        methodName: String(found.methodName),
        instance: found.class.instance,
        target: found.class.metatype,
      });
    }
  }

  getCronJobs(): RegisteredCronJob[] {
    return [...this.cronJobs];
  }

  getIntervalJobs(): RegisteredIntervalJob[] {
    return [...this.intervalJobs];
  }
}
