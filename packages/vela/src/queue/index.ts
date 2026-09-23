// @velajs/vela/queue — first-party queue subsystem, authored on the public API:
// every symbol src/queue/* imports from the rest of vela is exported by the root
// app kit or @velajs/vela/module-kit (the openness audit test enforces it).
// Consumers opt in through this subpath.
import '../metadata';

export { QueueModule, QUEUE_MODULE_OPTIONS } from './queue.module';
export { Processor, Process, InjectQueue, getProcessHandlers } from './queue.decorators';
export { queueToken, QUEUE_DRIVER, PROCESSOR_METADATA, PROCESS_METADATA } from './queue.tokens';
export { QueueClient } from './queue.client';
export type { QueueBulkEntry, QueueBulkJob, QueueBulkNamedJob } from './queue.client';
export { QueueBatchError } from './queue.errors';
export { QueueRegistry } from './queue.registry';
export { QueueDispatchBinding, dispatchQueueJob } from './queue.binding';
export type { QueueDispatchOptions, QueueDispatchResult, QueueEntry } from './queue.dispatch';
export { inline } from './inline.driver';
export type { InlineQueueDriver, InlineQueueOptions } from './inline.driver';
export { observeMessage, observeBatch } from './message-disposition';
export type {
  QueueMessageLike,
  MessageOutcome,
  MessageDisposition,
  ObserveMessageOptions,
  ObservedMessage,
  BatchDisposition,
  ObservedBatch,
} from './message-disposition';
export type {
  AddJobOptions,
  ProcessMetadata,
  ProcessorMetadata,
  QueueDispatchFn,
  QueueDispatchMode,
  QueueDriver,
  QueueDriverContext,
  QueueDriverEntrypoint,
  QueueDriverBindHooks,
  QueueDriverFactory,
  QueueEnqueueRequest,
  QueueJob,
  QueueModuleOptions,
  QueueRegistration,
  RegisteredQueue,
} from './queue.types';

export { defineQueueJob } from './queue.definition';
export type { QueueJobDefinition, QueueJobInput, QueueJobOutput } from './queue.definition';
export type { QueueProcessDecorator } from './queue.decorators';
export { parseQueueJob } from './queue.envelope';
