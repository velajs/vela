import { z } from 'zod';
import { SetMetadata, applyDecorators } from '../index';
import type { StandardSchemaV1 } from '../validation/index';
import { defineQueueJob, Process, QueueClient } from '../queue';
import type { QueueJob, QueueJobInput, QueueJobOutput } from '../queue';

declare const schema: StandardSchemaV1<{ count: string }, { count: number }>;
const definition = defineQueueJob('count', schema);
declare const client: QueueClient;
void client.add(definition, { count: '1' });
// @ts-expect-error producer must supply wire input, not transformed output
void client.add(definition, { count: 1 });
// @ts-expect-error missing required input field
void client.add(definition, {});
const input: QueueJobInput<typeof definition> = { count: '2' };
const output: QueueJobOutput<typeof definition> = { count: 2 };
void input;
void output;
class Consumer {
  @Process(definition)
  handle(job: QueueJob<QueueJobOutput<typeof definition>>) {
    return job.data.count.toFixed();
  }
  // @ts-expect-error consumer must accept transformed output
  @Process(definition)
  wrong(job: QueueJob<{ count: string }>) {
    return job.data.count;
  }
}
void Consumer;

// A typed @Process decorator composes with applyDecorators like any other decorator.
const CountJob = () => applyDecorators(Process(definition), SetMetadata('job', 'count'));
class ComposedConsumer {
  @CountJob()
  handle(job: QueueJob<QueueJobOutput<typeof definition>>) {
    return job.data.count.toFixed();
  }
}
void ComposedConsumer;

const zodJob = defineQueueJob('zod', z.object({ value: z.string().transform(Number) }));
void client.add(zodJob, { value: '42' });
// @ts-expect-error actual Zod schema input remains a string
void client.add(zodJob, { value: 42 });
const zodOutput: QueueJobOutput<typeof zodJob> = { value: 42 };
// @ts-expect-error actual Zod schema output is transformed
const badZodOutput: QueueJobOutput<typeof zodJob> = { value: '42' };
void zodOutput;
void badZodOutput;

// addBulk keeps each typed job's wire input, for literal tuples and mapped arrays alike.
void client
  .addBulk([
    { job: zodJob, data: { value: '1' } },
    { job: definition, data: { count: '2' }, options: { delayMs: 0 } },
  ])
  .then(([first, second]) => [first.data.value, second.data.count] satisfies [string, string]);
void client.addBulk(['1', '2'].map((value) => ({ job: zodJob, data: { value } })));
void client.addBulk([{ job: 'named', data: { free: true } }]);
// @ts-expect-error bulk data is the job's wire input, not its output
void client.addBulk([{ job: zodJob, data: { value: 1 } }]);

// Each entry is inferred on its own: named jobs may carry different payloads,
// and typed and named jobs may share one call.
void client
  .addBulk([
    { job: 'resize', data: { width: 100 } },
    { job: 'label', data: 'thumbnail' },
  ])
  .then(([resize, label]) => [resize.data.width, label.data] satisfies [number, string]);
void client
  .addBulk([
    { job: zodJob, data: { value: '1' } },
    { job: 'audit', data: { actor: 'system' }, options: { delayMs: 1000 } },
  ])
  .then(([typed, named]) => [typed.data.value, named.data.actor] satisfies [string, string]);
void client.addBulk([
  { job: 'audit', data: 1 },
  // @ts-expect-error a typed entry still checks its wire input next to named entries
  { job: zodJob, data: { value: 1 } },
]);
// @ts-expect-error entries use Vela's { job, data, options }, not BullMQ's { name, data, opts }
void client.addBulk([{ name: 'audit', data: 1, opts: {} }]);
// @ts-expect-error BullMQ's opts is not an entry key, so its options are not silently dropped
void client.addBulk([{ job: 'audit', data: 1, opts: { delayMs: 1000 } }]);
void client.addBulk([
  { job: zodJob, data: { value: '1' } },
  // @ts-expect-error a typed entry rejects keys outside { job, data, options } too
  { job: zodJob, data: { value: '2' }, opts: { delayMs: 1000 } },
]);
// @ts-expect-error mapped entries are checked for unknown keys as well
void client.addBulk(['1'].map((value) => ({ job: zodJob, data: { value }, delay: 1000 })));
// @ts-expect-error bulk options are the same AddJobOptions add() accepts
void client.addBulk([{ job: 'audit', data: 1, options: { delay: 1000 } }]);

// Legacy bind implementations may return ignored values; the void contract stays intact.
const legacyDriver: import('../queue').QueueDriver = {
  kind: 'legacy',
  enqueue: async () => {},
  bind: () => 42,
};
void legacyDriver;
