import { Module } from '@velajs/vela';
import { OpenApiModule } from '@velajs/vela/openapi';
import { QueueModule } from '@velajs/vela/queue';
import { cloudflareQueues } from '@velajs/cloudflare/queues';
import { TodosModule } from './todos/todos.module.js';

@Module({
  imports: [
    // One queue driver for the application: Cloudflare Queues, sending through
    // the producer bindings each QueueModule.forFeature([]) names.
    QueueModule.forRoot({ driver: cloudflareQueues() }),
    // GET /openapi.json: the OpenAPI 3.1 document of the application's routes.
    OpenApiModule.forRoot({ info: { title: '__PROJECT_NAME__', version: '0.0.0' } }),
    TodosModule,
  ],
})
export class AppModule {}
