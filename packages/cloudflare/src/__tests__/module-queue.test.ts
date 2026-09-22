import { describe, expect, it, vi } from 'vitest';
import {
  Inject,
  Injectable,
  InjectionToken,
  Module,
  Scope,
  EXECUTION_LIFETIME,
} from '@velajs/vela';
import type { ExecutionLifetime } from '@velajs/vela';
import { Process, Processor, QueueModule, queueToken } from '@velajs/vela/queue';
import type { QueueClient, QueueJob } from '@velajs/vela/queue';
import { createCloudflareApp, createCloudflareWorker } from '../cloudflare-factory';
import { cloudflareQueueDriver } from '../queue';
import { QueueConsumer } from '../decorators/queue-consumer';

const context = { waitUntil() {} };
const ENV = new InjectionToken<{ NAME: string }>('environment');
function message(name = 'run', data: unknown = {}, queue = 'tasks') {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    attempts: 2,
    body: { id: 'stable-job', queue, name, data, attempt: 1 },
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function fixture() {
  const seen: { env: string; scope: string; attempt: number }[] = [];
  @Injectable({ scope: Scope.REQUEST })
  class Resource {
    readonly id = crypto.randomUUID();
    dispose = vi.fn();
  }
  @Processor('tasks')
  @Injectable()
  class Tasks {
    constructor(
      @Inject(ENV) private env: { NAME: string },
      private resource: Resource,
      @Inject(EXECUTION_LIFETIME) private lifetime: ExecutionLifetime,
    ) {}
    @Process('run')
    async run(job: QueueJob<{ fail?: boolean; deferredFail?: boolean }>) {
      seen.push({ env: this.env.NAME, scope: this.resource.id, attempt: job.attempt });
      if (job.data.fail) throw new Error('handler failed');
      if (job.data.deferredFail)
        this.lifetime.waitUntil(Promise.reject(new Error('deferred failed')));
    }
  }
  @Module({
    imports: [
      QueueModule.forRootAsync({
        queues: ['tasks'],
        inject: [ENV],
        useFactory: async () => ({
          driver: cloudflareQueueDriver({}, { consumers: { 'tasks-test': 'tasks' } }),
        }),
      }),
    ],
    providers: [Tasks, Resource],
  })
  class App {}
  return { App, seen };
}

describe('QueueModule native wiring', () => {
  it('dispatches consumer-only modules on a cold event with isolated environments and native attempts', async () => {
    const { App, seen } = fixture();
    const worker = createCloudflareWorker(App, { envToken: ENV });
    const a = message(),
      b = message();
    await Promise.all([
      worker.queue({ queue: 'tasks-test', messages: [a] }, { NAME: 'a' }, context),
      worker.queue({ queue: 'tasks-test', messages: [b] }, { NAME: 'b' }, context),
    ]);
    expect(seen.map((x) => x.env).sort()).toEqual(['a', 'b']);
    expect(new Set(seen.map((x) => x.scope)).size).toBe(2);
    expect(seen.every((x) => x.attempt === 2)).toBe(true);
    expect(a.ack).toHaveBeenCalledOnce();
    expect(b.ack).toHaveBeenCalledOnce();
  });

  it('settles successful siblings and rejects malformed, unknown and deferred failures', async () => {
    const { App } = fixture();
    const worker = createCloudflareWorker(App, { envToken: ENV });
    const messages = [
      message(),
      message('run', { fail: true }),
      message('unknown'),
      message('run', { deferredFail: true }),
      message('run', {}, 'wrong'),
    ];
    await expect(
      worker.queue({ queue: 'tasks-test', messages }, { NAME: 'test' }, context),
    ).rejects.toThrow();
    expect(messages[0]!.ack).toHaveBeenCalledOnce();
    for (const item of messages.slice(1)) expect(item.ack).not.toHaveBeenCalled();
  });

  it('rejects unmapped physical queues without acknowledgement', async () => {
    const { App } = fixture();
    const worker = createCloudflareWorker(App, { envToken: ENV });
    const item = message();
    await expect(
      worker.queue({ queue: 'wrong', messages: [item] }, { NAME: 'test' }, context),
    ).rejects.toThrow('No consumer');
    expect(item.ack).not.toHaveBeenCalled();
  });

  it('rejects overlapping native and module consumer ownership at boot', async () => {
    const { App } = fixture();
    @Injectable()
    class Native {
      @QueueConsumer('tasks-test') async consume() {}
    }
    @Module({ imports: [App], providers: [Native] })
    class Root {}
    await expect(
      createCloudflareApp(Root, { env: { NAME: 'test' }, envToken: ENV }),
    ).rejects.toThrow('Ambiguous');
  });

  it('awaits native sends in producer-only modules and publishes binding metadata', async () => {
    const send = vi.fn(async () => {});
    const queueModule = QueueModule.forRoot({
      queues: ['tasks'],
      driver: cloudflareQueueDriver({ tasks: { send } }, { producerBindings: { tasks: 'TASKS' } }),
    });
    @Module({ imports: [queueModule] })
    class Root {}
    const app = await createCloudflareApp(Root, { env: { NAME: 'test' }, envToken: ENV });
    const client: QueueClient = app.get(queueToken('tasks'));
    await client.add('run', { value: 1 });
    expect(send).toHaveBeenCalledOnce();
    expect(app.entrypoints.ofKind('cf:queue:producer')[0]?.meta).toEqual({
      logicalQueue: 'tasks',
      binding: 'TASKS',
    });
    await app.close();
  });
});

describe('async dynamic Worker roots', () => {
  it('shares cold factory work, evicts failures, and keeps dynamic providers', async () => {
    let calls = 0;
    @Module({})
    class Root {}
    const worker = createCloudflareWorker(
      {
        async create() {
          calls++;
          await Promise.resolve();
          if (calls === 1) throw new Error('retry bootstrap');
          return { module: Root, imports: [fixture().App] };
        },
      },
      { envToken: ENV },
    );
    const env = { NAME: 'same' };
    const first = () => worker.queue({ queue: 'tasks-test', messages: [message()] }, env, context);
    const results = await Promise.allSettled([first(), first()]);
    expect(results.every((x) => x.status === 'rejected')).toBe(true);
    expect(calls).toBe(1);
    await Promise.all([first(), first()]);
    expect(calls).toBe(2);
  });
});
