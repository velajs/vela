import type { QueueJob } from './queue.types';

/** Validate transport data without interpreting its application payload. */
export function parseQueueJob(value: unknown, deliveryAttempt?: number): QueueJob {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !value.id.trim() ||
    !('queue' in value) ||
    typeof value.queue !== 'string' ||
    !value.queue.trim() ||
    !('name' in value) ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    !('data' in value)
  ) {
    throw new TypeError('Invalid queue job envelope. Expected id, queue, name and data.');
  }
  const attempt = deliveryAttempt ?? ('attempt' in value ? value.attempt : undefined);
  if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new TypeError('Queue delivery attempt must be a positive safe integer.');
  }
  return { id: value.id, queue: value.queue, name: value.name, data: value.data, attempt };
}
