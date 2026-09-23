import { Cron, InjectEnv, Module, ScheduleModule, type VelaEnv } from '@velajs/vela';
import { createCloudflareWorker } from '@velajs/cloudflare';
import { cloudflareQueues } from '@velajs/cloudflare/queues';
import { Process, Processor, QueueModule, type QueueJob } from '@velajs/vela/queue';
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
    // Consumer-only: 'tasks' jobs arrive from the module-tasks queue this Worker consumes.
    QueueModule.forRoot({ driver: cloudflareQueues() }),
    QueueModule.registerQueue({ name: 'tasks', consumer: 'module-tasks' }),
  ],
  providers: [Tasks],
})
class JobsModule {}
export default createCloudflareWorker(JobsModule);
