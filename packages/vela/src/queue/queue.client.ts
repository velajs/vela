import type { AddJobOptions, QueueDriver, QueueJob } from './queue.types';

/**
 * Producer handle for one named queue — inject via `queueToken(name)`:
 *
 * ```ts
 * constructor(@Inject(queueToken('email')) private readonly email: QueueClient) {}
 * await this.email.add('welcome', { userId });
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

  async add<T>(jobName: string, data: T, options: AddJobOptions = {}): Promise<QueueJob<T>> {
    const job: QueueJob<T> = {
      id: crypto.randomUUID(),
      queue: this.#queue,
      name: jobName,
      data,
      attempt: 1,
    };
    await this.#driver.enqueue(job, options);
    return job;
  }
}
