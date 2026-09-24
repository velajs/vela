import { Process, Processor, type QueueJob, type QueueJobOutput } from '@velajs/vela/queue';
import { Notifier } from '../notifications/notifier.service.js';
import { TODO_EVENTS, todoCreated } from './todo-events.js';

// Cloudflare delivers the queue's batches to the Worker; QueueModule routes
// each job here by its logical queue and name, and acknowledges it once the
// handler resolves. A handler that throws leaves the message to be retried.
@Processor(TODO_EVENTS)
export class TodoEventsProcessor {
  readonly #notifier: Notifier;

  constructor(notifier: Notifier) {
    this.#notifier = notifier;
  }

  @Process(todoCreated)
  created(job: QueueJob<QueueJobOutput<typeof todoCreated>>): void {
    this.#notifier.notify(`Todo created: ${job.data.title}`);
  }
}
