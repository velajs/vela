import { isStandardSchema } from '../validation/standard-schema';
import type { StandardSchemaV1 } from '../validation/standard-schema';

/** Shared wire contract. The transport carries schema input, handlers receive output. */
export interface QueueJobDefinition<S extends StandardSchemaV1 = StandardSchemaV1> {
  readonly name: string;
  readonly schema: S;
}

export type QueueJobInput<D extends QueueJobDefinition> = StandardSchemaV1.InferInput<D['schema']>;
export type QueueJobOutput<D extends QueueJobDefinition> = StandardSchemaV1.InferOutput<
  D['schema']
>;

/** Define a job once and share it between producer and processor. */
export function defineQueueJob<const N extends string, S extends StandardSchemaV1>(
  name: N,
  schema: S,
): QueueJobDefinition<S> & { readonly name: N } {
  if (!name.trim()) throw new TypeError('Queue job name must not be empty.');
  if (!isStandardSchema(schema))
    throw new TypeError('Queue job schema must implement Standard Schema.');
  return Object.freeze({ name, schema });
}
