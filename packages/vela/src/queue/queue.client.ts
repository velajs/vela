import { validateSchema } from '../index';
import type { StandardSchemaV1 } from '../index';
import type { QueueJobDefinition } from './queue.definition';
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
    let wire = data;
    if (typeof jobName !== 'string') {
      // Keep wire input separate from transformed output. Snapshot before awaiting
      // validation so neither caller nor validator mutations change the sent job.
      wire = structuredClone(data);
      await validateSchema(jobName.schema, structuredClone(wire));
    }
    const job: QueueJob<T> = {
      id: crypto.randomUUID(),
      queue: this.#queue,
      name: typeof jobName === 'string' ? jobName : jobName.name,
      data: wire,
      attempt: 1,
    };
    await this.#driver.enqueue(job, options);
    return job;
  }
}
