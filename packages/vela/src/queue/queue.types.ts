import type { InvocationTarget } from '../dispatch/types';
import type { StandardSchemaV1 } from '../validation/standard-schema';
import type { VelaEnv } from '../env';
import type { QueueRegistry } from './queue.registry';

/**
 * One job as handed to `@Process` handlers and drivers. Ids are minted by the
 * client via `crypto.randomUUID()` (Web Crypto — edge-safe).
 */
export interface QueueJob<T = unknown> {
  id: string;
  /**
   * Logical queue the job was added to: the `QueueModule.registerQueue({ name })`
   * its client belongs to. Native delivery routes a job by this name.
   */
  queue: string;
  /** Job name — matched against `@Process(name)`; unnamed handlers catch the rest. */
  name: string;
  data: T;
  /** Delivery attempt, 1-based. Platform drivers increment on retry. */
  attempt: number;
}

export interface AddJobOptions {
  /**
   * Requested delivery delay. Honored only by drivers that support it — the
   * in-core `inline()` driver does not and warns once (log diagnostics).
   */
  delayMs?: number;
}

/** One job of a batch handed to {@link QueueDriver.enqueueBatch}. */
export interface QueueEnqueueRequest {
  readonly job: QueueJob;
  readonly options?: AddJobOptions;
}

/** The function a driver calls to deliver one job into the app's processors. */
export type QueueDispatchFn = (job: QueueJob) => Promise<void>;

export interface QueueDriverBindHooks {
  /**
   * Where fire-and-forget delivery errors go (the inline driver's
   * `immediate` mode has no awaiter to rethrow into). Wired to the
   * container's diagnostics by `QueueDispatchBinding`.
   */
  onError?: (error: unknown, job: QueueJob) => void;
}

/**
 * Producer/transport seam. `enqueue` accepts a job for later (or immediate)
 * delivery; drivers that deliver in-process implement `bind` to receive the
 * app's dispatch function. Platform packages (Cloudflare Queues, Redis, …)
 * implement this interface out-of-core.
 */
export interface QueueDriver {
  readonly kind: string;
  /** Platform routes contributed by QueueModule; no platform types enter core. */
  readonly entrypoints?: readonly QueueDriverEntrypoint[];
  /** Await native delivery and settlement, using the module's dispatch policy. */
  consume?(payload: unknown, dispatch: QueueDispatchFn): Promise<void>;
  enqueue(job: QueueJob, options?: AddJobOptions): Promise<void>;
  /**
   * Accept several jobs at once (`QueueClient.addBulk`). Resolve only when the
   * transport accepted every job; otherwise reject, with a `QueueBatchError`
   * naming the jobs it already accepted. Without it, `addBulk` enqueues the
   * jobs one at a time.
   */
  enqueueBatch?(requests: readonly QueueEnqueueRequest[]): Promise<void>;
  bind?(dispatch: QueueDispatchFn, hooks?: QueueDriverBindHooks): void;
  /** Release an application's binding at disposal. Optional for legacy drivers. */
  unbind?(): void;
}

/** A platform route a driver contributes, for example a native queue consumer. */
export interface QueueDriverEntrypoint {
  readonly kind: string;
  readonly meta: Readonly<Record<string, unknown>>;
}

/** What `QueueModule` hands a driver factory when it builds one application's driver. */
export interface QueueDriverContext {
  /** The application's `ENV`, when a runtime seeded one (the Worker environment on Cloudflare). */
  readonly env: VelaEnv | undefined;
  /** The queues this application registered with `QueueModule.registerQueue`. */
  readonly queues: QueueRegistry;
}

/** Builds a fresh driver for each application, from that application's context. */
export type QueueDriverFactory = (context: QueueDriverContext) => QueueDriver;

/**
 * One `QueueModule.registerQueue` entry. `name` is the logical queue: the
 * `@InjectQueue(name)` client, the `@Processor(name)` handlers and every
 * job's `queue`.
 */
export interface QueueRegistration {
  readonly name: string;
  /**
   * The transport binding the driver sends this queue's jobs through. On
   * Workers it is the Wrangler `queues.producers[].binding`, read from `ENV`
   * when a job is added. Omit it in applications that only consume the queue.
   */
  readonly binding?: string;
  /**
   * The physical queue this application consumes the jobs from. Setting it
   * pins the queue to that physical queue: its jobs are accepted only from
   * it, and that physical queue may only carry the queues pinned to it.
   * Without it, delivery routes each job by its `queue`, from any physical
   * queue.
   */
  readonly consumer?: string;
}

/** Every registration of one logical queue in an application, merged. */
export interface RegisteredQueue {
  readonly name: string;
  /** The binding the registrations agree on, if any declared one. */
  readonly binding: string | undefined;
  /** Physical queues pinned by `consumer`, in registration order. */
  readonly consumers: readonly string[];
}

/**
 * How a delivered job reaches its handling logic.
 *
 * `direct` (default) runs the in-isolate `@Processor`/`@Process` path
 * unchanged. `signed` re-enters the app through a per-invocation SIGNED route
 * (`ctx.run`): the job is re-issued as a signed HTTP request to a
 * user-authored `@SignedInvocation()` route, so the processing logic runs
 * through the FULL request pipeline (global guards/interceptors/filters) that
 * the direct `@Processor` path deliberately bypasses — and, with a
 * cross-isolate transport, can even land in the Worker that owns the routes.
 *
 * Purely additive: absent (or `{ kind: 'direct' }`) keeps today's behavior.
 */
export type QueueDispatchMode =
  | { readonly kind: 'direct' }
  | {
      readonly kind: 'signed';
      /** Maps a delivered job to the route/path it re-enters. */
      readonly target: (job: QueueJob) => InvocationTarget;
      /** HTTP method for the signed re-entry request (default `POST`). */
      readonly method?: string;
      /** Signed-claim lifetime override (seconds). */
      readonly ttlSeconds?: number;
    };

export interface QueueModuleOptions {
  /**
   * Defaults to `inline()`. A factory builds a fresh driver for each
   * application and receives that application's `ENV` and registered queues.
   */
  driver?: QueueDriver | QueueDriverFactory;
  /**
   * Opt-in signed re-entry for delivered jobs (default `direct`). Every
   * delivery through the module honors it: the inline driver's and a
   * platform driver's native consumer alike. A signed policy is keyed by
   * reference, like the driver: a different policy object is a different
   * `forRoot` configuration, which fails bootstrap, even when it differs only
   * in a captured target.
   */
  dispatch?: QueueDispatchMode;
}

/** Class-level meta written by `@Processor(queueName)` (the 'queue' entrypoint kind). */
export interface ProcessorMetadata {
  queueName: string;
}

/** Per-handler meta written by `@Process(jobName?)`. */
export interface ProcessMetadata {
  jobName?: string;
  /** Opt-in wire validation; parsed output is passed to the processor. */
  schema?: StandardSchemaV1;
  methodName: string | symbol;
}
