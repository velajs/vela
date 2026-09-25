import type { Pipeline } from 'cloudflare:pipelines';
import { z } from 'zod';
import {
  createPipelinesWriter,
  type PipelinesBinding,
  type PipelinesWriter,
} from '@velajs/cloudflare/pipelines';

const event = z.object({ id: z.string(), count: z.string().transform(Number) });

export async function verifyPublishedPipelines(
  native: Pipeline<{ id: string; count: number }>,
  untyped: Pipeline,
  wrongOutput: Pipeline<{ id: string; count: string }>,
  extraRequired: Pipeline<{ id: string; count: number; required: true }>,
) {
  const binding: PipelinesBinding<z.output<typeof event>> = native;
  const writer = createPipelinesWriter(binding, { schema: event });
  const inputs: PipelinesWriter<z.input<typeof event>> = writer;
  const accepted: void = await inputs.send([{ id: 'sample', count: '2' }]);
  void accepted;
  await createPipelinesWriter(untyped, { schema: event }).send([{ id: 'sample', count: '2' }]);
  await native.send([{ id: 'native', count: 2 }]);
  // @ts-expect-error send accepts schema inputs, not transformed outputs
  await writer.send([{ id: 'sample', count: 2 }]);
  // @ts-expect-error schema outputs must match the native stream record
  createPipelinesWriter(wrongOutput, { schema: event });
  // @ts-expect-error a native binding cannot require fields the schema does not produce
  createPipelinesWriter(extraRequired, { schema: event });
  // @ts-expect-error a stream writer requires an object-producing schema
  createPipelinesWriter(untyped, { schema: z.string() });
  // @ts-expect-error options cannot invent a schema input type
  const wrongInput: PipelinesWriter<{ id: number; count: string }> = writer;
  void wrongInput;
}
