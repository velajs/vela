import { EntrypointRegistry } from '../entrypoint/entrypoint.registry';
import { InternalDispatcher } from '../dispatch/internal-dispatcher';
import { resolveErrorReporter } from '../exceptions/reporter';
import type { Container } from '../container/container';
import type { DiscoveryService } from '../discovery/discovery.service';
import { dispatchJobToProcessors, unreportedQueueFailures } from './queue.dispatch';
import { readProcessorMetadata } from './queue.decorators';
import type { QueueDispatchOptions, QueueDispatchResult, QueueEntry } from './queue.dispatch';
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
          `once in the root module and register queues with QueueModule.forFeature([]).`,
      );
    }

    if (driver.bind) {
      if (ownedDrivers.has(driver)) {
        throw new Error(
          'Queue driver already belongs to an application. Use a driver factory for isolated reuse.',
        );
      }
      const unbind = driver.bind(
        async (job) => {
          await this.#deliver(job);
        },
        {
          onError: (error, job) => this.#routeError(error, job),
        },
      );
      if (typeof unbind !== 'function')
        throw new TypeError('Queue driver bind() must return a cleanup function.');
      this.#unbind = unbind;
      ownedDrivers.add(driver);
    }
  }

  dispose(): void {
    this.#closed = true;
    this.#unbind?.();
    this.#unbind = undefined;
  }

  /**
   * Deliver one job a platform consumer (or a custom transport, through
   * `dispatchQueueJob`) received, through the module's dispatch policy.
   * Rejects, so the platform retries the message instead of acknowledging it,
   * when the job's queue is not registered in this application or, unless
   * `options.unhandled` is `'ignore'`, when no processor handles it. Options
   * that leave `unhandled` out keep that `'error'` default.
   */
  async dispatch(job: QueueJob, options: QueueDispatchOptions = {}): Promise<QueueDispatchResult> {
    if (this.#closed) throw new Error('Queue module is closed.');
    if (!this.#queues.has(job.queue)) {
      throw new Error(
        `Queue '${job.queue}' is not registered in this application. Register it with ` +
          `QueueModule.forFeature([{ name: '${job.queue}' }]) in the module that processes it.`,
      );
    }
    return this.#deliver(job, { ...options, unhandled: options.unhandled ?? 'error' });
  }

  async #deliver(job: QueueJob, options: QueueDispatchOptions = {}): Promise<QueueDispatchResult> {
    if (this.#closed) return { handled: 0 };
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
      return { handled: 1 };
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

    return dispatchJobToProcessors(this.#container, entries, job, options);
  }

  #routeError(error: unknown, job: QueueJob): void {
    const mode = this.#container.getDiagnostics();
    if (mode === 'silent') return;
    if (mode === 'throw') {
      throw error instanceof Error ? error : new Error(String(error));
    }
    // Fire-and-forget (inline `immediate`) deliveries have no awaiter to rethrow
    // into — route their unclaimed errors to the exception handler instead of a
    // bare console.error. A processor already reported its own failure.
    const reporter = resolveErrorReporter(this.#container);
    for (const failure of unreportedQueueFailures(error)) {
      reporter.report(failure, {
        edge: 'queue',
        source: `${job.queue}/${job.name}`,
        note: 'inline driver',
      });
    }
  }
}

/**
 * Deliver one job to its queue's processors: the entry point for tests and
 * custom transports other than Cloudflare Queues, which `cloudflareQueues()`
 * delivers itself. A raw `@QueueConsumer` must not carry jobs of registered
 * queues, so it is not a transport to bridge through this function.
 *
 * In an application that imports `QueueModule.forRoot()`, delivery goes
 * through the module's `QueueDispatchBinding`, the dispatcher native
 * deliveries use: the job's queue must be registered, and signed dispatch
 * re-enters the job's route, so the route's global guards run and cannot be
 * bypassed. Without a `QueueModule`, the job goes directly to the
 * `@Processor` providers listed in `entrypoints`.
 *
 * Like a native delivery, it rejects a job no processor handles (a misspelled
 * or removed job name, or a queue without processors), so a transport that
 * acknowledges a message when this resolves, and retries it when this
 * rejects, never loses one. `options.unhandled: 'ignore'` opts into resolving
 * with `handled: 0` instead.
 */
export async function dispatchQueueJob(
  container: Container,
  entrypoints: EntrypointRegistry,
  job: QueueJob,
  options: QueueDispatchOptions = {},
): Promise<QueueDispatchResult> {
  const unhandled = options.unhandled ?? 'error';
  if (container.has(QueueDispatchBinding)) {
    const binding = await container.resolveAsync(QueueDispatchBinding);
    return binding.dispatch(job, { unhandled });
  }
  const entries: QueueEntry[] = entrypoints
    .ofKind('queue', readProcessorMetadata)
    .map((ep) => ({ token: ep.token, meta: ep.meta, moduleId: ep.moduleId }));
  return dispatchJobToProcessors(container, entries, job, { unhandled });
}
