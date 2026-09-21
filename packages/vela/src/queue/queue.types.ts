import type { InvocationTarget, StandardSchemaV1 } from '../index';

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
  bind?(dispatch: QueueDispatchFn, hooks?: QueueDriverBindHooks): void | (() => void);
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
   * Queue names this instance provides clients for. STRUCTURAL — must be
   * known at `forRoot`/`forRootAsync` call time (clients are options-derived
   * providers); `forRootAsync` callers pass it alongside the factory.
   */
  queues?: string[];
  /** Defaults to inline(). A factory creates a fresh driver per application. */
  driver?: QueueDriver | (() => QueueDriver);
  /**
   * Opt-in signed re-entry for delivered jobs (default `direct`). STRUCTURAL —
   * like `queues`, pass it alongside the factory for `forRootAsync`. The
   * `dispatch.kind` participates in the module dedup key, so a `signed`
   * instance never dedups with a `direct` one.
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
