import { parseSchemaAsync } from '../index';
import type { StandardSchemaV1 } from '../index';
import type { QueueJobDefinition } from './queue.definition';
import { QueueBatchError } from './queue.errors';
import type { AddJobOptions, QueueDriver, QueueEnqueueRequest, QueueJob } from './queue.types';

/** One job of an `addBulk` call, described by a shared job definition. */
export interface QueueBulkJob<S extends StandardSchemaV1 = StandardSchemaV1> {
  readonly job: QueueJobDefinition<S>;
  /** Wire input, validated by the definition's schema before any job is sent. */
  readonly data: StandardSchemaV1.InferInput<S>;
  readonly options?: AddJobOptions;
}

/** One job of an `addBulk` call, named by string (no validation). */
export interface QueueBulkNamedJob<T = unknown> {
  readonly job: string;
  readonly data: T;
  readonly options?: AddJobOptions;
}

/**
 * One `addBulk` entry: the arguments of one `add(job, data, options)` call as
 * `{ job, data, options }` (not BullMQ's `{ name, data, opts }`).
 */
export type QueueBulkEntry = QueueBulkJob | QueueBulkNamedJob;

/** A typed entry must carry its definition's wire input; a named entry carries any data. */
type CheckedBulkEntry<E> = E extends { readonly job: QueueJobDefinition<infer S> }
  ? QueueBulkJob<S>
  : E;

type BulkEntryResult<E> = E extends { readonly job: QueueJobDefinition<infer S> }
  ? QueueJob<StandardSchemaV1.InferInput<S>>
  : E extends { readonly data: infer T }
    ? QueueJob<T>
    : never;

/**
 * Producer handle for one registered queue. Inject it with `@InjectQueue(name)`
 * (or `@Inject(queueToken(name))`):
 *
 * ```ts
 * constructor(@InjectQueue('email') private readonly email: QueueClient) {}
 * await this.email.add(welcome, { userId });
 * ```
 *
 * `add()` resolves when the DRIVER accepted the job, not when a processor
 * handled it (the inline driver's `immediate` mode delivers on a following
 * microtask; platform drivers deliver in another isolate entirely).
 */
export class QueueClient {
  readonly #queue: string;
  readonly #driver: QueueDriver;

  constructor(queue: string, driver: QueueDriver) {
    this.#queue = queue;
    this.#driver = driver;
  }

  get name(): string {
    return this.#queue;
  }

  add<S extends StandardSchemaV1>(
    definition: QueueJobDefinition<S>,
    data: StandardSchemaV1.InferInput<S>,
    options?: AddJobOptions,
  ): Promise<QueueJob<StandardSchemaV1.InferInput<S>>>;
  add<T>(jobName: string, data: T, options?: AddJobOptions): Promise<QueueJob<T>>;
  async add<T>(
    jobName: string | QueueJobDefinition,
    data: T,
    options: AddJobOptions = {},
  ): Promise<QueueJob<T>> {
    const job = await this.#job(jobName, data);
    await this.#driver.enqueue(job, options);
    return job;
  }

  /**
   * Add several jobs at once. Each entry has the shape of an `add()` call,
   * `{ job, data, options? }`, and is typed on its own: a typed entry's `data`
   * is its definition's wire input, a named entry's `data` is free, and both
   * may share one call. Every typed job is validated before the driver sees
   * any of them. A driver with `enqueueBatch` receives the whole batch
   * (Cloudflare sends it in as few native calls as the platform limits allow);
   * any other driver receives one job at a time. Resolves only when every job
   * was accepted; otherwise rejects with a `QueueBatchError` naming the jobs
   * that were.
   */
  addBulk<J extends readonly QueueBulkEntry[] | []>(
    jobs: J & { readonly [K in keyof J]: CheckedBulkEntry<J[K]> },
  ): Promise<{ -readonly [K in keyof J]: BulkEntryResult<J[K]> }>;
  async addBulk(jobs: readonly QueueBulkEntry[]): Promise<QueueJob<unknown>[]> {
    const requests: QueueEnqueueRequest[] = [];
    for (const entry of jobs) {
      // Sequential on purpose: a failing validation stops before later work.
      // eslint-disable-next-line no-await-in-loop
      const job = await this.#job(entry.job, entry.data);
      requests.push(entry.options === undefined ? { job } : { job, options: entry.options });
    }
    if (requests.length === 0) return [];
    if (this.#driver.enqueueBatch) {
      await this.#driver.enqueueBatch(requests);
    } else {
      for (const [index, request] of requests.entries()) {
        try {
          // Order matters, and a failure must stop the remaining sends.
          // eslint-disable-next-line no-await-in-loop
          await this.#driver.enqueue(request.job, request.options);
        } catch (error) {
          throw new QueueBatchError(
            requests.slice(0, index).map(({ job }) => job.id),
            requests.slice(index).map(({ job }) => job.id),
            error,
          );
        }
      }
    }
    return requests.map(({ job }) => job);
  }

  async #job<T>(jobName: string | QueueJobDefinition, data: T): Promise<QueueJob<T>> {
    let wire = data;
    if (typeof jobName !== 'string') {
      // Keep wire input separate from transformed output. Snapshot before awaiting
      // validation so neither caller nor validator mutations change the sent job.
      wire = structuredClone(data);
      await parseSchemaAsync(jobName.schema, structuredClone(wire));
    }
    return {
      id: crypto.randomUUID(),
      queue: this.#queue,
      name: typeof jobName === 'string' ? jobName : jobName.name,
      data: wire,
      attempt: 1,
    };
  }
}
