import { EntrypointRegistry, InternalDispatcher, resolveErrorReporter } from '../index';
import type { Container, DiscoveryService } from '../index';
import { dispatchJobToEntries } from './queue.dispatch';
import { readProcessorMetadata } from './queue.decorators';
import type { QueueEntry } from './queue.dispatch';
import { PROCESSOR_METADATA, queueToken } from './queue.tokens';
import type { QueueDispatchMode, QueueDriver, QueueJob } from './queue.types';

const ownedDrivers = new WeakSet<QueueDriver>();

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
  readonly #container: Container;
  readonly #discovery: DiscoveryService;
  readonly #dispatch: QueueDispatchMode | undefined;
  #unbind: (() => void) | undefined;
  #closed = false;
  constructor(
    container: Container,
    discovery: DiscoveryService,
    driver: QueueDriver,
    queues: string[],
    dispatch?: QueueDispatchMode,
  ) {
    this.#container = container;
    this.#discovery = discovery;
    this.#dispatch = dispatch;
    for (const queue of queues) {
      const owners = container.getOwnerModuleIds(queueToken(queue));
      if (owners.length > 1) {
        throw new Error(
          `Queue '${queue}' is provided by multiple QueueModule instances (${owners.join(', ')}). ` +
            `Queue names must be unique per app — either dedup the forRoot options or rename the queue.`,
        );
      }
    }

    if (driver.bind) {
      if (ownedDrivers.has(driver)) {
        throw new Error(
          'Queue driver already belongs to an application. Use a driver factory for isolated reuse.',
        );
      }
      const unbind = driver.bind((job) => this.#deliver(job), {
        onError: (error, job) => this.#routeError(error, job),
      });
      this.#unbind = typeof unbind === 'function' ? unbind : undefined;
      ownedDrivers.add(driver);
    }
  }

  dispose(): void {
    this.#closed = true;
    this.#unbind?.();
    this.#unbind = undefined;
  }

  async #deliver(job: QueueJob): Promise<void> {
    if (this.#closed) return;
    // Opt-in signed re-entry: the job re-enters a user-authored
    // `@SignedInvocation()` route through `ctx.run` instead of the direct
    // in-isolate `@Processor` path, so it runs the full HTTP pipeline (and,
    // with a cross-isolate transport, can cross back to the routing Worker).
    // `InternalDispatcher` is a bootstrap-registered global token, so it
    // resolves from the root container the binding holds.
    if (this.#dispatch?.kind === 'signed') {
      const dispatch = this.#dispatch;
      await this.#container.resolve(InternalDispatcher).run(dispatch.target(job), {
        body: job,
        method: dispatch.method,
        ttlSeconds: dispatch.ttlSeconds,
        iss: `queue:${job.queue}`,
      });
      return;
    }

    const entries: QueueEntry[] = this.#container.has(EntrypointRegistry)
      ? this.#container
          .resolve(EntrypointRegistry)
          .ofKind('queue', readProcessorMetadata)
          .map((ep) => ({ token: ep.token, meta: ep.meta }))
      : this.#discovery
          .providersWithMeta(PROCESSOR_METADATA, { deferLazy: true })
          .map((found) => ({ token: found.token, meta: readProcessorMetadata(found.meta) }));

    await dispatchJobToEntries(this.#container, entries, job);
  }

  #routeError(error: unknown, job: QueueJob): void {
    const mode = this.#container.getDiagnostics();
    if (mode === 'silent') return;
    if (mode === 'throw') {
      throw error instanceof Error ? error : new Error(String(error));
    }
    // Fire-and-forget (inline `immediate`) deliveries have no awaiter to rethrow
    // into — route their unclaimed errors to the exception handler instead of a
    // bare console.error.
    resolveErrorReporter(this.#container).report(error, {
      edge: 'queue',
      source: `${job.queue}/${job.name}`,
      note: 'inline driver',
    });
  }
}
