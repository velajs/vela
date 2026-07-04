// @velajs/vela/queue — first-party queue subsystem, authored entirely on the
// public API (every vela import in src/queue/* comes from '../index'; the
// openness audit test enforces it). Deliberately NOT re-exported from the
// main barrel: @velajs/cloudflare already exports an (unrelated) QueueModule
// for the CF Queues binding, and subpath-only avoids the collision.
export { QueueModule, QUEUE_MODULE_OPTIONS } from './queue.module';
export { Processor, Process, getProcessHandlers } from './queue.decorators';
export { queueToken, QUEUE_DRIVER, PROCESSOR_METADATA, PROCESS_METADATA } from './queue.tokens';
export { QueueClient } from './queue.client';
export { QueueDispatchBinding } from './queue.binding';
export { dispatchQueueJob } from './queue.dispatch';
export type { QueueDispatchResult, QueueEntry } from './queue.dispatch';
export { inline } from './inline.driver';
export type { InlineQueueDriver, InlineQueueOptions } from './inline.driver';
export type {
  AddJobOptions,
  ProcessMetadata,
  ProcessorMetadata,
  QueueDispatchFn,
  QueueDriver,
  QueueDriverBindHooks,
  QueueJob,
  QueueModuleOptions,
} from './queue.types';
