import { describe, expect, it } from 'vitest';
import {
  Controller,
  Get,
  Inject,
  Injectable,
  InjectEnv,
  InjectionToken,
  Module,
  Param,
  defineProvider,
  type VelaEnv,
} from '@velajs/vela';
import {
  Process,
  Processor,
  QueueModule,
  defineQueueJob,
  type QueueJob,
  type QueueJobOutput,
} from '@velajs/vela/queue';
import { Cron, type CronInvocation } from '@velajs/vela/schedule';
import type { StandardSchemaV1 } from '@velajs/vela/validation';
import { cloudflareQueues } from '../../queues';
import { createTestingWorker, queueJob } from '../../testing';

/** A string variable wrangler.test.toml seeds into ENV. */
function variable(env: VelaEnv, name: string): string {
  const value: unknown = Reflect.get(env, name);
  return typeof value === 'string' ? value : 'unset';
}

// A tiny Standard Schema, so the suite needs no schema library.
const todoCreatedSchema: StandardSchemaV1<{ id: string }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(value) {
      return typeof value === 'object' &&
        value !== null &&
        'id' in value &&
        typeof value.id === 'string'
        ? { value: { id: value.id } }
        : { issues: [{ message: 'expected { id: string }' }] };
    },
  },
};
const todoCreated = defineQueueJob('todo.created', todoCreatedSchema);

const CLOCK = new InjectionToken<{ now(): string }>('clock');
const seen: string[] = [];

@Injectable()
class Notifier {
  notify(message: string): void {
    seen.push(message);
  }
}

@Module({ providers: [Notifier], exports: [Notifier] })
class NotifyModule {}

@Processor('todos')
class TodoJobs {
  constructor(
    private readonly notifier: Notifier,
    @InjectEnv() private readonly env: VelaEnv,
  ) {}

  @Process(todoCreated)
  created(job: QueueJob<QueueJobOutput<typeof todoCreated>>) {
    if (job.data.id === 'broken') throw new Error('retry me');
    this.notifier.notify(`created ${job.data.id} (${variable(this.env, 'ENV_PROBE')})`);
  }
}

@Injectable()
class Nightly {
  constructor(@Inject(CLOCK) private readonly clock: { now(): string }) {}

  @Cron('0 3 * * *', { dialect: 'cloudflare' })
  run(tick: CronInvocation) {
    seen.push(`nightly ${tick.expression} at ${this.clock.now()}`);
  }
}

@Controller('/todos')
class TodosController {
  constructor(@Inject(CLOCK) private readonly clock: { now(): string }) {}

  @Get('/:id')
  find(@Param('id') id: string) {
    return { id, at: this.clock.now() };
  }
}

@Module({
  imports: [
    NotifyModule,
    QueueModule.forRoot({ driver: cloudflareQueues() }),
    QueueModule.registerQueue({ name: 'todos', binding: 'QUEUE_BRIDGE' }),
  ],
  controllers: [TodosController],
  providers: [TodoJobs, Nightly, defineProvider(CLOCK, { useValue: { now: () => 'real time' } })],
})
class AppModule {}

describe('createTestingWorker under workerd', () => {
  it('serves requests through the Worker pipeline with overridden providers', async () => {
    const worker = await createTestingWorker(AppModule, {
      globalPrefix: '/api',
      overrides: (module) => module.overrideProvider(CLOCK).useValue({ now: () => 'test time' }),
    });
    try {
      const response = await worker.fetch('/api/todos/1');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: '1', at: 'test time' });
      expect(worker.module.get(CLOCK).now()).toBe('test time');
    } finally {
      await worker.close();
    }
  });

  it('closes after responses whose bodies a test never read', async () => {
    const worker = await createTestingWorker(AppModule);
    const missing = await worker.fetch('/missing');
    const found = await worker.fetch(new Request('http://worker.test/todos/2'));
    expect(missing.status).toBe(404);
    expect(found.status).toBe(200);
    await worker.close();
  }, 3000);

  it('delivers a queue batch and reports what the handler acknowledged', async () => {
    seen.length = 0;
    const worker = await createTestingWorker(AppModule);
    try {
      const result = await worker.queue('todos-native', [
        queueJob('todos', todoCreated, { id: 'a' }, { id: 'message-a' }),
        queueJob('todos', todoCreated, { id: 'broken' }, { id: 'message-b' }),
      ]);
      expect(seen).toEqual(['created a (workerd-env)']);
      expect(result.outcome).toBe('exception');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.ackAll).toBe(false);
      expect(result.explicitAcks).toEqual(['message-a']);

      const clean = await worker.queue('todos-native', [
        queueJob('todos', todoCreated, { id: 'c' }),
      ]);
      expect(clean.outcome).toBe('ok');
      expect(clean.error).toBeUndefined();
      expect(clean.explicitAcks).toHaveLength(1);
    } finally {
      await worker.close();
    }
  });

  it('runs the @Cron jobs of a trigger and rejects a cron no job declares', async () => {
    seen.length = 0;
    const worker = await createTestingWorker(AppModule, {
      overrides: (module) => module.overrideProvider(CLOCK).useValue({ now: () => 'midnight' }),
    });
    try {
      await worker.scheduled('0 3 * * *', { scheduledTime: Date.UTC(2026, 0, 1, 3) });
      expect(seen).toEqual(['nightly 0 3 * * * at midnight']);
      await expect(worker.scheduled('0 4 * * *')).rejects.toThrow(/0 3 \* \* \*/);
    } finally {
      await worker.close();
    }
  });

  it('replaces modules and mocks what nothing provides', async () => {
    seen.length = 0;
    const notified: string[] = [];
    @Module({})
    class NoNotifier {}
    const worker = await createTestingWorker(AppModule, {
      overrides: (module) =>
        module
          .overrideModule(NotifyModule)
          .useModule(NoNotifier)
          .useMocker((token) =>
            token === Notifier
              ? { notify: (message: string) => notified.push(message) }
              : undefined,
          ),
    });
    try {
      const result = await worker.queue('todos-native', [
        queueJob('todos', 'todo.created', { id: 'd' }),
      ]);
      expect(result.outcome).toBe('ok');
      expect(notified).toEqual(['created d (workerd-env)']);
      expect(seen).toEqual([]);
    } finally {
      await worker.close();
    }
  });
});
