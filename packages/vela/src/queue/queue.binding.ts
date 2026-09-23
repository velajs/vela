import { EntrypointRegistry, InternalDispatcher, resolveErrorReporter } from '../index';
import type { Container, DiscoveryService } from '../index';
import { dispatchJobToEntries } from './queue.dispatch';
import { readProcessorMetadata } from './queue.decorators';
import type { QueueEntry } from './queue.dispatch';
import type { QueueRegistry } from './queue.registry';
import { PROCESSOR_METADATA, QUEUE_DRIVER } from './queue.tokens';
import type { QueueDispatchMode, QueueDriver, QueueJob } from './queue.types';

const ownedDrivers = new WeakSet<QueueDriver>();

/**
 * Wires the application's `QueueModule` driver to the app and is the one
 * dispatcher every delivery goes through: in-process drivers bind to it, and
 * platform consumers (`consume`) call {@link dispatch}. Both honor the module's
 * `dispatch` policy, so signed re-entry applies to native deliveries too.
 *
 * Delivery resolves processors from the per-app `EntrypointRegistry` once it
 * exists (registered into the container at the end of
 * `callOnApplicationBootstrap`); deliveries that arrive earlier (a producer's
 * `onModuleInit` calling `add()`) fall back to `DiscoveryService` with
 * `metadataOnly` — identical owners, no buffering, no lost jobs.
 *
 * Every `QueueClient` injects this binding, so the driver is always bound
 * before the first `add()` — including when the module materializes lazily.
 */
export class QueueDispatchBinding {
  readonly #container: Container;
  readonly #discovery: DiscoveryService;
  readonly #queues: QueueRegistry;
  readonly #dispatch: QueueDispatchMode | undefined;
  #unbind: (() => void) | undefined;
  #closed = false;
  constructor(
    container: Container,
    discovery: DiscoveryService,
    driver: QueueDriver,
    queues: QueueRegistry,
    dispatch?: QueueDispatchMode,
  ) {
    this.#container = container;
    this.#discovery = discovery;
    this.#queues = queues;
    this.#dispatch = dispatch;
    const owners = container.getOwnerModuleIds(QUEUE_DRIVER);
    if (owners.length > 1) {
      throw new Error(
        `QueueModule.forRoot() is imported with different options by ${owners.join(', ')}. ` +
          `An application configures its queue driver once: import QueueModule.forRoot() ` +
          `once in the root module and register queues with QueueModule.registerQueue().`,
      );
    }

    if (driver.bind) {
      if (ownedDrivers.has(driver)) {
        throw new Error(
          'Queue driver already belongs to an application. Use a driver factory for isolated reuse.',
        );
      }
      driver.bind((job) => this.#deliver(job), {
        onError: (error, job) => this.#routeError(error, job),
      });
      this.#unbind = () => driver.unbind?.();
      ownedDrivers.add(driver);
    }
  }

  dispose(): void {
    this.#closed = true;
    this.#unbind?.();
    this.#unbind = undefined;
  }

  /**
   * Deliver one job a platform consumer received, through the module's
   * dispatch policy. Rejects, so the platform retries the message instead of
   * acknowledging it, when the job's queue is not registered in this
   * application or no processor handles it.
   */
  async dispatch(job: QueueJob): Promise<void> {
    if (this.#closed) throw new Error('Queue module is closed.');
    if (!this.#queues.has(job.queue)) {
      throw new Error(
        `Queue '${job.queue}' is not registered in this application. Register it with ` +
          `QueueModule.registerQueue({ name: '${job.queue}' }) in the module that processes it.`,
      );
    }
    await this.#deliver(job, true);
  }

  async #deliver(job: QueueJob, strict = false): Promise<void> {
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
          .map((ep) => ({ token: ep.token, meta: ep.meta, moduleId: ep.moduleId }))
      : this.#discovery
          .registrationsWithMeta(PROCESSOR_METADATA, { metadataOnly: true })
          .map((found) => ({
            token: found.token,
            meta: readProcessorMetadata(found.meta),
            moduleId: found.moduleId,
          }));

    await dispatchJobToEntries(this.#container, entries, job, {
      unhandled: strict ? 'error' : 'ignore',
    });
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
