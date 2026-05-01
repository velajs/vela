import {
  Body,
  Controller,
  Cron,
  Get,
  Injectable,
  MetadataRegistry,
  Module,
  Param,
  Post,
} from '@velajs/vela';
import {
  AIModule,
  AIService,
  D1Module,
  D1Service,
  DurableObjectModule,
  DurableObjectService,
  Env,
  HyperdriveModule,
  HyperdriveService,
  KVModule,
  KVService,
  QueueConsumer,
  QueueModule,
  QueueService,
  R2Module,
  R2Service,
  Scheduled,
  VectorizeModule,
  VectorizeService,
  createCloudflareApp,
} from '@velajs/cloudflare';
import type { CloudflareApplication, CloudflareEnv } from '@velajs/cloudflare';

function defineWorkerBindingsLabModule() {
  MetadataRegistry.clear();

  @Injectable()
  class WorkerBindingFacade {
    constructor(
      private readonly kv: KVService,
      private readonly d1: D1Service,
      private readonly r2: R2Service,
      private readonly queue: QueueService<unknown>,
      private readonly durableObject: DurableObjectService,
      private readonly ai: AIService,
      private readonly vectorize: VectorizeService,
      private readonly hyperdrive: HyperdriveService,
    ) {}

    async writeKV(key: string, value: string) {
      await this.kv.namespace.put(key, value);
      return { key, value };
    }

    async readKV(key: string) {
      return { key, value: await this.kv.namespace.get(key) };
    }

    async findUser(id: string) {
      const user = await this.d1.database
        .prepare('SELECT * FROM users WHERE id = ?')
        .bind(id)
        .first();
      return { user };
    }

    async putAsset(key: string, value: string) {
      await this.r2.bucket.put(key, value);
      return { key, stored: true };
    }

    async getAsset(key: string) {
      const object = await this.r2.bucket.get(key);
      return { key, value: object ? await object.text() : null };
    }

    async enqueue(body: unknown) {
      await this.queue.queue.send(body);
      return { queued: true };
    }

    async durableObjectStatus(name: string) {
      const id = this.durableObject.namespace.idFromName(name);
      const stub = this.durableObject.namespace.get(id);
      const response = await stub.fetch(`https://worker-bindings-lab.test/counters/${name}`);
      return response.json();
    }

    async runAI(input: unknown) {
      const ai = this.ai.binding as unknown as {
        run: (model: string, input: unknown) => Promise<unknown>;
      };
      return ai.run('@cf/meta/llama-3.1-8b-instruct', input);
    }

    async search() {
      const index = this.vectorize.index as unknown as {
        query: (vector: number[], options: { topK: number }) => Promise<unknown>;
      };
      return index.query([0.1, 0.2, 0.3], { topK: 1 });
    }

    hyperdriveInfo() {
      return {
        connectionString: this.hyperdrive.connectionString,
        host: this.hyperdrive.host,
        port: this.hyperdrive.port,
        user: this.hyperdrive.user,
        database: this.hyperdrive.database,
      };
    }
  }

  @Controller('/lab')
  class WorkerBindingsController {
    constructor(private readonly bindings: WorkerBindingFacade) {}

    @Get('/env')
    envSummary(
      @Env() env: Record<string, unknown>,
      @Env('CACHE') cache: unknown,
    ) {
      return {
        hasCache: cache === env.CACHE,
        keys: Object.keys(env).sort(),
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
    @Scheduled('*/15 * * * *')
    scheduled(event: { cron: string }, env: CloudflareEnv) {
      (env.EVENT_LOG as string[]).push(`scheduled:${event.cron}`);
    }

    @Cron('0 * * * *')
    velaCron(event: { cron: string }, env: CloudflareEnv) {
      (env.EVENT_LOG as string[]).push(`cron:${event.cron}`);
    }

    @QueueConsumer('JOB_QUEUE')
    queue(batch: { queue: string; messages: Array<{ body: unknown }> }, env: CloudflareEnv) {
      (env.EVENT_LOG as string[]).push(`queue:${batch.messages.length}`);
    }
  }

  @Module({
    imports: [
      KVModule.forRoot({ binding: 'CACHE' }),
      D1Module.forRoot({ binding: 'DB' }),
      R2Module.forRoot({ binding: 'ASSETS' }),
      QueueModule.forRoot({ binding: 'JOB_QUEUE' }),
      DurableObjectModule.forRoot({ binding: 'COUNTER_DO' }),
      AIModule.forRoot({ binding: 'AI' }),
      VectorizeModule.forRoot({ binding: 'VECTORIZE' }),
      HyperdriveModule.forRoot({ binding: 'HYPERDRIVE' }),
    ],
    providers: [WorkerBindingFacade, WorkerEvents],
    controllers: [WorkerBindingsController],
  })
  class WorkerBindingsLabModule {}

  return WorkerBindingsLabModule;
}

export async function createWorkerBindingsLabApp(): Promise<CloudflareApplication> {
  return createCloudflareApp(defineWorkerBindingsLabModule());
}
