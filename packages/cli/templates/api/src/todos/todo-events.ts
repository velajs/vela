import { defineQueueJob } from '@velajs/vela/queue';
import { z } from 'zod';

/** The logical queue: QueueModule.registerQueue({ name }) and @Processor(name). */
export const TODO_EVENTS = 'todo-events';

/** Shared by the producer (TodosService) and the processor, validated on both sides. */
export const todoCreated = defineQueueJob(
  'todo.created',
  z.object({ id: z.string(), title: z.string() }),
);
