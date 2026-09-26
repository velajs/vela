import { createDiscoverableDecorator } from '../discovery/discoverable.decorator';
import { defineMetadata, getMetadata } from '../metadata';
import { Inject } from '../container/decorators';
import { registerEntrypointKind } from '../entrypoint/entrypoint.registry';
import { PROCESS_METADATA, PROCESSOR_METADATA, queueToken } from './queue.tokens';
import type { StandardSchemaV1 } from '../validation/standard-schema';
import type { QueueJobDefinition } from './queue.definition';
import type { QueueJob, ProcessMetadata, ProcessorMetadata } from './queue.types';

const ProcessorMeta = createDiscoverableDecorator<ProcessorMetadata>(PROCESSOR_METADATA);

// The open entrypoint kind: adapters enumerate processors via
// `app.entrypoints.ofKind('queue', readProcessorMetadata)`. Declared at import
// time next to the decorator — zero kernel involvement.
registerEntrypointKind({ kind: 'queue', metaKey: PROCESSOR_METADATA, level: 'class' });

/** Validate metadata recovered from the open entrypoint registry. */
export function readProcessorMetadata(value: unknown): ProcessorMetadata {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('queueName' in value) ||
    typeof value.queueName !== 'string'
  ) {
    throw new Error('Invalid queue entrypoint metadata: queueName must be a string.');
  }
  return { queueName: value.queueName };
}

/**
 * Inject the `QueueClient` of a queue registered with
 * `QueueModule.forFeature([{ name }])`. Same as `@Inject(queueToken(name))`:
 *
 * ```ts
 * constructor(@InjectQueue('email') private readonly email: QueueClient) {}
 * ```
 */
export function InjectQueue(name: string): ParameterDecorator {
  return Inject(queueToken(name));
}

/**
 * Marks a provider class as a processor for one queue:
 *
 * ```ts
 * @Processor('email') // implies @Injectable()
 * class EmailProcessor {
 *   @Process('welcome')
 *   async sendWelcome(job: QueueJob<{ userId: string }>) { ... }
 * }
 * ```
 */
export function Processor(queueName: string): ClassDecorator {
  return ProcessorMeta({ queueName }) as ClassDecorator;
}

/**
 * Marks a processor method as the handler for a job name. Omit the name for
 * the wildcard handler (receives every job on the queue that has no named
 * handler). Named handlers win over the wildcard; a duplicate registration
 * for the same name is first-wins with a diagnostics warning at dispatch.
 */
export type QueueProcessDecorator<Data> = <Handler extends (job: QueueJob<Data>) => unknown>(
  target: object,
  key: string | symbol,
  descriptor: TypedPropertyDescriptor<Handler>,
) => void;

export function Process<S extends StandardSchemaV1>(
  definition: QueueJobDefinition<S>,
): QueueProcessDecorator<StandardSchemaV1.InferOutput<S>>;
export function Process(jobName?: string): MethodDecorator;
export function Process(jobName?: string | QueueJobDefinition): MethodDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const ctor = target.constructor;
    const existing = [
      ...((getMetadata(PROCESS_METADATA, ctor) as ProcessMetadata[] | undefined) ?? []),
    ];
    const definition = typeof jobName === 'object' ? jobName : undefined;
    existing.push({
      jobName: definition?.name ?? (typeof jobName === 'string' ? jobName : undefined),
      schema: definition?.schema,
      methodName: propertyKey,
    });
    defineMetadata(PROCESS_METADATA, existing, ctor);
  };
}

/** `@Process` entries declared on a processor class (declaration order). */
export function getProcessHandlers(processorClass: object): ProcessMetadata[] {
  return (getMetadata(PROCESS_METADATA, processorClass) as ProcessMetadata[] | undefined) ?? [];
}
