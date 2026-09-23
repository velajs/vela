import { Cron, InjectEnv, Injectable, Module, ScheduleModule, type VelaEnv } from '@velajs/vela';
import { createCloudflareWorker } from '@velajs/cloudflare';
import { cloudflareQueueDriver } from '@velajs/cloudflare/queue';
import { Process, Processor, QueueModule, type QueueJob } from '@velajs/vela/queue';
@Injectable()
@Processor('tasks')
class Tasks {
  // RESULTS is typed by worker-configuration.jobs.d.ts.
  constructor(@InjectEnv() private env: VelaEnv) {}
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
export default createCloudflareWorker({ create: async () => ({ module: JobsModule }) });
