import {
  Body,
  Controller,
  Cron,
  Get,
  InjectEnv,
  Injectable,
  Module,
  Param,
  Post,
  type CronInvocation,
  type VelaEnv,
} from '@velajs/vela';
import { QueueConsumer, createCloudflareApp, createCloudflareWorker } from '@velajs/cloudflare';
import { cloudflareQueues } from '@velajs/cloudflare/queues';
import {
  InjectQueue,
  Process,
  Processor,
  QueueModule,
  defineQueueJob,
  type QueueClient,
  type QueueJob,
  type QueueJobOutput,
} from '@velajs/vela/queue';
import { z } from 'zod';

/** A typed job: producers send its schema input, the processor receives its output. */
const syncReport = defineQueueJob('sync-report', z.object({ id: z.number().int() }));

@Injectable()
class WorkerBindingFacade {
  constructor(@InjectEnv() private readonly env: VelaEnv) {}

  async writeKV(key: string, value: string) {
    await this.env.CACHE.put(key, value);
    return { key, value };
  }

  async readKV(key: string) {
    return { key, value: await this.env.CACHE.get(key) };
  }

  async findUser(id: string) {
    const user = await this.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    return { user };
  }

  async putAsset(key: string, value: string) {
    await this.env.ASSETS.put(key, value);
    return { key, stored: true };
  }

  async getAsset(key: string) {
    const object = await this.env.ASSETS.get(key);
    return { key, value: object ? await object.text() : null };
  }

  async enqueue(body: unknown) {
    await this.env.JOB_QUEUE.send(body);
    return { queued: true };
  }

  async durableObjectStatus(name: string) {
    const id = this.env.COUNTER_DO.idFromName(name);
    const stub = this.env.COUNTER_DO.get(id);
    const response = await stub.fetch(`https://worker-bindings-lab.test/counters/${name}`);
    return response.json();
  }

  async runAI(input: unknown) {
    if (
      typeof input !== 'object' ||
      input === null ||
      !('prompt' in input) ||
      typeof input.prompt !== 'string'
    ) {
      throw new TypeError('AI input requires a prompt string');
    }
    return this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', { prompt: input.prompt });
  }

  async search() {
    return this.env.VECTORIZE.query([0.1, 0.2, 0.3], { topK: 1 });
  }

  hyperdriveInfo() {
    return {
      connectionString: this.env.HYPERDRIVE.connectionString,
      host: this.env.HYPERDRIVE.host,
      port: this.env.HYPERDRIVE.port,
      user: this.env.HYPERDRIVE.user,
      database: this.env.HYPERDRIVE.database,
    };
  }
}

@Controller('/lab')
class WorkerBindingsController {
  constructor(
    private readonly bindings: WorkerBindingFacade,
    @InjectEnv() private readonly env: VelaEnv,
    @InjectQueue('reports') private readonly reports: QueueClient,
  ) {}

  @Get('/env')
  envSummary() {
    return {
      hasCache: this.env.CACHE !== undefined,
      keys: Object.keys(this.env).sort(),
    };
  }

  @Post('/kv/:key')
  writeKV(@Param('key') key: string, @Body('value') value: string) {
    return this.bindings.writeKV(key, value);
  }

  @Get('/kv/:key')
  readKV(@Param('key') key: string) {
    return this.bindings.readKV(key);
  }

  @Get('/d1/users/:id')
  findUser(@Param('id') id: string) {
    return this.bindings.findUser(id);
  }

  @Post('/r2/:key')
  putAsset(@Param('key') key: string, @Body('value') value: string) {
    return this.bindings.putAsset(key, value);
  }

  @Get('/r2/:key')
  getAsset(@Param('key') key: string) {
    return this.bindings.getAsset(key);
  }

  @Post('/queue')
  enqueue(@Body() body: unknown) {
    return this.bindings.enqueue(body);
  }

  // Portable jobs: QueueModule sends through the REPORT_QUEUE producer binding.
  @Post('/reports')
  async report(@Body('id') id: number) {
    await this.reports.add(syncReport, { id });
    return { queued: true };
  }

  @Get('/durable-object/:name')
  durableObjectStatus(@Param('name') name: string) {
    return this.bindings.durableObjectStatus(name);
  }

  @Post('/ai')
  runAI(@Body() body: unknown) {
    return this.bindings.runAI(body);
  }

  @Get('/vectorize')
  search() {
    return this.bindings.search();
  }

  @Get('/hyperdrive')
  hyperdrive() {
    return this.bindings.hyperdriveInfo();
  }
}

@Injectable()
class WorkerEvents {
  constructor(@InjectEnv() private readonly env: VelaEnv) {}

  // Each expression matches a Wrangler `triggers.crons` entry exactly.
  @Cron('*/15 * * * *', { dialect: 'cloudflare' })
  quarterHourly(tick: CronInvocation) {
    this.env.EVENT_LOG.push(`quarter-hourly:${tick.scheduledTime}`);
  }

  @Cron('0 * * * *', { dialect: 'cloudflare' })
  hourly(tick: CronInvocation) {
    this.env.EVENT_LOG.push(`hourly:${tick.scheduledTime}`);
  }

  @QueueConsumer('JOB_QUEUE')
  queue(batch: { queue: string; messages: Array<{ body: unknown }> }) {
    this.env.EVENT_LOG.push(`queue:${batch.messages.length}`);
  }
}

// Delivered by the Worker's queue() handler: batches no @QueueConsumer claims
// are routed to processors by each job's logical queue.
@Processor('reports')
class ReportProcessor {
  constructor(@InjectEnv() private readonly env: VelaEnv) {}

  @Process(syncReport)
  sync(job: QueueJob<QueueJobOutput<typeof syncReport>>) {
    this.env.EVENT_LOG.push(`report:${job.data.id}`);
  }
}

@Module({
  imports: [
    QueueModule.forRoot({ driver: cloudflareQueues() }),
    QueueModule.registerQueue({ name: 'reports', binding: 'REPORT_QUEUE' }),
  ],
  providers: [WorkerBindingFacade, WorkerEvents, ReportProcessor],
  controllers: [WorkerBindingsController],
})
export class WorkerBindingsLabModule {}

export async function createWorkerBindingsLabApp(env: VelaEnv) {
  return createCloudflareApp(WorkerBindingsLabModule, { env });
}

export function createWorkerBindingsLabWorker() {
  return createCloudflareWorker(WorkerBindingsLabModule);
}
