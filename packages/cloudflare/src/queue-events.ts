/** Validated platform event subscriptions inside an existing native @QueueConsumer. */
export {
  defineQueueEvent,
  consumeQueueEvents,
  QueueEventError,
  QueueEventsBatchError,
} from './queue-events/consume';
export type {
  QueueEvent,
  QueueEventContext,
  QueueEventHandler,
  QueueEventOptions,
  QueueEventFailure,
  QueueEventErrorCode,
  ConsumeQueueEventsOptions,
} from './queue-events/consume';
