import { Injectable, Inject } from '../container/index';
import { DiscoveryService } from '../discovery/discovery.service';
import type { Entrypoint } from '../entrypoint/entrypoint.types';
import type { OnApplicationBootstrap } from '../lifecycle/index';
import { CRON_METADATA, INTERVAL_METADATA } from './schedule.tokens';
import { parseCronMetadata, parseIntervalMetadata } from './schedule.metadata';
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
  readonly #discovery: DiscoveryService;
  #cron: Entrypoint<CronMetadata>[] = [];
  #interval: Entrypoint<IntervalMetadata>[] = [];

  constructor(@Inject(DiscoveryService) discovery: DiscoveryService) {
    this.#discovery = discovery;
  }

  onApplicationBootstrap(): void {
    this.#cron = this.#discovery
      .registeredMethodsWithMeta(CRON_METADATA, { metadataOnly: true })
      .map((found) => ({
        kind: 'schedule:cron',
        token: found.class.token,
        moduleId: found.class.moduleId,
        instance: undefined,
        methodName: found.methodName,
        meta: parseCronMetadata(found.meta),
      }));
    this.#interval = this.#discovery
      .registeredMethodsWithMeta(INTERVAL_METADATA, { metadataOnly: true })
      .map((found) => ({
        kind: 'schedule:interval',
        token: found.class.token,
        moduleId: found.class.moduleId,
        instance: undefined,
        methodName: found.methodName,
        meta: parseIntervalMetadata(found.meta),
      }));
  }

  /** Metadata-only execution descriptors, including request-scoped and async providers. */
  getCronEntrypoints(): Entrypoint<CronMetadata>[] {
    return this.#cron.map((entry) => ({ ...entry, meta: { ...entry.meta } }));
  }

  getIntervalEntrypoints(): Entrypoint<IntervalMetadata>[] {
    return this.#interval.map((entry) => ({ ...entry, meta: { ...entry.meta } }));
  }

  /** Legacy instance view for introspection; never used to execute a scheduled job. */
  getCronJobs(): RegisteredCronJob[] {
    return this.#discovery.methodsWithMeta<CronMetadata>(CRON_METADATA).flatMap((found) => {
      if (!found.class.instance) return [];
      const meta = parseCronMetadata(found.meta);
      return [
        {
          expression: meta.expression,
          methodName: String(found.methodName),
          instance: found.class.instance,
          target: found.class.metatype,
        },
      ];
    });
  }

  getIntervalJobs(): RegisteredIntervalJob[] {
    return this.#discovery.methodsWithMeta<IntervalMetadata>(INTERVAL_METADATA).flatMap((found) => {
      if (!found.class.instance) return [];
      const meta = parseIntervalMetadata(found.meta);
      return [
        {
          ms: meta.ms,
          methodName: String(found.methodName),
          instance: found.class.instance,
          target: found.class.metatype,
        },
      ];
    });
  }
}
