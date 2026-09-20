import {
  Body,
  Controller,
  Cron,
  Get,
  Injectable,
  Inject,
  InjectionToken,
  MetadataRegistry,
  Module,
  Param,
  Post,
} from "@velajs/vela";
import {
  Env,
  QueueConsumer,
  Scheduled,
  createCloudflareApp,
  createCloudflareWorker,
} from "@velajs/cloudflare";
import type { WorkerBindingsLabEnv } from "./mock-env.js";

export const WORKER_ENV = new InjectionToken<WorkerBindingsLabEnv>("worker lab bindings");

function defineWorkerBindingsLabModule() {
  MetadataRegistry.clear();

  @Injectable()
  class WorkerBindingFacade {
    constructor(@Inject(WORKER_ENV) private readonly env: WorkerBindingsLabEnv) {}

    async writeKV(key: string, value: string) {
      await this.env.CACHE.put(key, value);
      return { key, value };
    }

    async readKV(key: string) {
      return { key, value: await this.env.CACHE.get(key) };
    }

    async findUser(id: string) {
      const user = await this.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
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
        typeof input !== "object" ||
        input === null ||
        !("prompt" in input) ||
        typeof input.prompt !== "string"
      ) {
        throw new TypeError("AI input requires a prompt string");
      }
      return this.env.AI.run("@cf/meta/llama-3.1-8b-instruct", { prompt: input.prompt });
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

  @Controller("/lab")
  class WorkerBindingsController {
    constructor(private readonly bindings: WorkerBindingFacade) {}

    @Get("/env")
    envSummary(@Env() env: Record<string, unknown>, @Env("CACHE") cache: unknown) {
      return {
        hasCache: cache === env.CACHE,
        keys: Object.keys(env).sort(),
      };
    }

    @Post("/kv/:key")
    writeKV(@Param("key") key: string, @Body("value") value: string) {
      return this.bindings.writeKV(key, value);
    }

    @Get("/kv/:key")
    readKV(@Param("key") key: string) {
      return this.bindings.readKV(key);
    }

    @Get("/d1/users/:id")
    findUser(@Param("id") id: string) {
      return this.bindings.findUser(id);
    }

    @Post("/r2/:key")
    putAsset(@Param("key") key: string, @Body("value") value: string) {
      return this.bindings.putAsset(key, value);
    }

    @Get("/r2/:key")
    getAsset(@Param("key") key: string) {
      return this.bindings.getAsset(key);
    }

    @Post("/queue")
    enqueue(@Body() body: unknown) {
      return this.bindings.enqueue(body);
    }

    @Get("/durable-object/:name")
    durableObjectStatus(@Param("name") name: string) {
      return this.bindings.durableObjectStatus(name);
    }

    @Post("/ai")
    runAI(@Body() body: unknown) {
      return this.bindings.runAI(body);
    }

    @Get("/vectorize")
    search() {
      return this.bindings.search();
    }

    @Get("/hyperdrive")
    hyperdrive() {
      return this.bindings.hyperdriveInfo();
    }
  }

  @Injectable()
  class WorkerEvents {
    @Scheduled("*/15 * * * *")
    scheduled(event: { cron: string }, env: WorkerBindingsLabEnv) {
      env.EVENT_LOG.push(`scheduled:${event.cron}`);
    }

    @Cron("0 * * * *")
    velaCron(event: { cron: string }, env: WorkerBindingsLabEnv) {
      env.EVENT_LOG.push(`cron:${event.cron}`);
    }

    @QueueConsumer("JOB_QUEUE")
    queue(batch: { queue: string; messages: Array<{ body: unknown }> }, env: WorkerBindingsLabEnv) {
      env.EVENT_LOG.push(`queue:${batch.messages.length}`);
    }
  }

  @Module({
    providers: [WorkerBindingFacade, WorkerEvents],
    controllers: [WorkerBindingsController],
  })
  class WorkerBindingsLabModule {}

  return WorkerBindingsLabModule;
}

export async function createWorkerBindingsLabApp(env: WorkerBindingsLabEnv) {
  return createCloudflareApp(defineWorkerBindingsLabModule(), { env, envToken: WORKER_ENV });
}

export function createWorkerBindingsLabWorker() {
  return createCloudflareWorker(defineWorkerBindingsLabModule(), { envToken: WORKER_ENV });
}
