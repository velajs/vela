/**
 * One job as handed to `@Process` handlers and drivers. Ids are minted by the
 * client via `crypto.randomUUID()` (Web Crypto — edge-safe).
 */
export interface QueueJob<T = unknown> {
  id: string;
  /** Queue the job was added to (`QueueModule.forRoot({ queues })` name). */
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
  enqueue(job: QueueJob, options?: AddJobOptions): Promise<void>;
  bind?(dispatch: QueueDispatchFn, hooks?: QueueDriverBindHooks): void;
}

export interface QueueModuleOptions {
  /**
   * Queue names this instance provides clients for. STRUCTURAL — must be
   * known at `forRoot`/`forRootAsync` call time (clients are options-derived
   * providers); `forRootAsync` callers pass it alongside the factory.
   */
  queues?: string[];
  /** Defaults to the in-core `inline()` driver. */
  driver?: QueueDriver;
}

/** Class-level meta written by `@Processor(queueName)` (the 'queue' entrypoint kind). */
export interface ProcessorMetadata {
  queueName: string;
}

/** Per-handler meta written by `@Process(jobName?)`. */
export interface ProcessMetadata {
  jobName?: string;
  methodName: string | symbol;
}
