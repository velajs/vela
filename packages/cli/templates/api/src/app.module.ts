import { Module } from '@velajs/vela';
import { QueueModule } from '@velajs/vela/queue';
import { cloudflareQueues } from '@velajs/cloudflare/queues';
import { TodosModule } from './todos/todos.module.js';

@Module({
  // One queue driver for the application: Cloudflare Queues, sending through
  // the producer bindings each QueueModule.registerQueue() names.
  imports: [QueueModule.forRoot({ driver: cloudflareQueues() }), TodosModule],
})
export class AppModule {}
