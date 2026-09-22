import { Cron, Inject, Injectable, InjectionToken, Module, ScheduleModule } from '@velajs/vela';
import { createCloudflareWorker } from '@velajs/cloudflare';
import { cloudflareQueueDriver } from '@velajs/cloudflare/queue';
import { Process, Processor, QueueModule, type QueueJob } from '@velajs/vela/queue';
interface Env {
  RESULTS: KVNamespace;
}
const ENV = new InjectionToken<Env>('jobs environment');
@Injectable()
@Processor('tasks')
class Tasks {
  constructor(@Inject(ENV) private env: Env) {}
  @Process('record') async record(job: QueueJob<{ source: string }>) {
    await this.env.RESULTS.put(
      'last-job',
      JSON.stringify({ source: job.data.source, attempt: job.attempt }),
    );
  }
  @Cron('* * * * *', { dialect: 'cloudflare' }) async tick() {
    await this.env.RESULTS.put('last-cron', 'completed');
  }
}
@Module({
  imports: [
    ScheduleModule.forRoot(),
    QueueModule.forRoot({
      queues: ['tasks'],
      driver: cloudflareQueueDriver({}, { consumers: { 'module-tasks': 'tasks' } }),
    }),
  ],
  providers: [Tasks],
})
class JobsModule {}
export default createCloudflareWorker(
  { create: async () => ({ module: JobsModule }) },
  { envToken: ENV },
);
