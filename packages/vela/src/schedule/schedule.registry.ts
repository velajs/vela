import { Injectable, Inject } from '../container/index';
import { DiscoveryService } from '../discovery/discovery.service';
import type { Entrypoint } from '../entrypoint/entrypoint.types';
import type { OnApplicationBootstrap } from '../lifecycle/index';
import { CRON_METADATA, INTERVAL_METADATA } from './schedule.tokens';
import { parseCronMetadata, parseIntervalMetadata } from './schedule.metadata';
import type { CronMetadata, IntervalMetadata } from './schedule.types';

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
}
