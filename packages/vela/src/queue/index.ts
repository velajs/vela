// @velajs/vela/queue — first-party queue subsystem, authored entirely on the
// public API (every vela import in src/queue/* comes from '../index'; the
// openness audit test enforces it). Deliberately NOT re-exported from the
// main barrel: consumers opt in through this subpath.
export { QueueModule, QUEUE_MODULE_OPTIONS } from './queue.module';
export { Processor, Process, InjectQueue, getProcessHandlers } from './queue.decorators';
export { queueToken, QUEUE_DRIVER, PROCESSOR_METADATA, PROCESS_METADATA } from './queue.tokens';
export { QueueClient } from './queue.client';
export type { QueueBulkJob, QueueBulkNamedJob } from './queue.client';
export { QueueBatchError } from './queue.errors';
export { QueueRegistry } from './queue.registry';
export { QueueDispatchBinding } from './queue.binding';
export { dispatchQueueJob } from './queue.dispatch';
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
