import { Module } from '@velajs/vela';
import { QueueModule } from '@velajs/vela/queue';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { TODO_EVENTS } from './todo-events.js';
import { TodoEventsProcessor } from './todo-events.processor.js';
import { TodosController } from './todos.controller.js';
import { TodosCleanup } from './todos.cron.js';
import { TodosService } from './todos.service.js';

@Module({
  imports: [
    // The queue this module produces and processes; TODO_EVENTS is its
    // Wrangler queues.producers binding.
    QueueModule.registerQueue({ name: TODO_EVENTS, binding: 'TODO_EVENTS' }),
    NotificationsModule,
  ],
  controllers: [TodosController],
  providers: [TodosService, TodoEventsProcessor, TodosCleanup],
})
export class TodosModule {}
