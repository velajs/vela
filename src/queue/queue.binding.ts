import { EntrypointRegistry } from '../index';
import type { Container, DiscoveryService } from '../index';
import { dispatchJobToEntries } from './queue.dispatch';
import type { QueueEntry } from './queue.dispatch';
import { PROCESSOR_METADATA, queueToken } from './queue.tokens';
import type { ProcessorMetadata, QueueDriver, QueueJob } from './queue.types';

/**
 * Wires a `QueueModule` instance's driver to the app: binds in-process
 * delivery to the dispatch core and validates that no other module instance
 * provides the same queue names.
 *
 * Delivery resolves processors from the per-app `EntrypointRegistry` once it
 * exists (registered into the container at the end of
 * `callOnApplicationBootstrap`); deliveries that arrive earlier (a producer's
 * `onModuleInit` calling `add()`) fall back to `DiscoveryService` with
 * `deferLazy` — identical entries, no buffering, no lost jobs.
 *
 * Every `QueueClient` injects this binding, so the driver is always bound
 * before the first `add()` — including when the module materializes lazily.
 */
export class QueueDispatchBinding {
  constructor(
    private readonly container: Container,
    private readonly discovery: DiscoveryService,
    driver: QueueDriver,
    queues: string[],
  ) {
    for (const queue of queues) {
      const owners = container.getOwnerModuleIds(queueToken(queue));
      if (owners.length > 1) {
        throw new Error(
          `Queue '${queue}' is provided by multiple QueueModule instances (${owners.join(', ')}). ` +
            `Queue names must be unique per app — either dedup the forRoot options or rename the queue.`,
        );
      }
    }

    driver.bind?.(
      (job) => this.deliver(job),
      { onError: (error, job) => this.routeError(error, job) },
    );
  }

  private async deliver(job: QueueJob): Promise<void> {
    const entries: QueueEntry[] = this.container.has(EntrypointRegistry)
      ? this.container
          .resolve(EntrypointRegistry)
          .ofKind<ProcessorMetadata>('queue')
          .map((ep) => ({ token: ep.token, meta: ep.meta }))
      : this.discovery
          .providersWithMeta<ProcessorMetadata>(PROCESSOR_METADATA, { deferLazy: true })
          .map((found) => ({ token: found.token, meta: found.meta }));

    await dispatchJobToEntries(this.container, entries, job);
  }

  private routeError(error: unknown, job: QueueJob): void {
    const mode = this.container.getDiagnostics();
    if (mode === 'silent') return;
    if (mode === 'throw') {
      throw error instanceof Error ? error : new Error(String(error));
    }
    console.error(
      `[vela] unhandled error processing queue job '${job.name}' on '${job.queue}':`,
      error,
    );
  }
}
