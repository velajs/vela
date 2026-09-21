import { z } from 'zod';
import type { StandardSchemaV1 } from '../index';
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

const zodJob = defineQueueJob('zod', z.object({ value: z.string().transform(Number) }));
void client.add(zodJob, { value: '42' });
// @ts-expect-error actual Zod schema input remains a string
void client.add(zodJob, { value: 42 });
const zodOutput: QueueJobOutput<typeof zodJob> = { value: 42 };
// @ts-expect-error actual Zod schema output is transformed
const badZodOutput: QueueJobOutput<typeof zodJob> = { value: '42' };
void zodOutput;
void badZodOutput;
