import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_GUARD,
  Controller,
  Cron,
  Global,
  Injectable,
  MetadataRegistry,
  Module,
  Post,
  ScheduleModule,
  SignedInvocation,
  URL_SIGNING_SECRET,
  VelaFactory,
  defineProvider,
  type CanActivate,
  type ExecutionContext,
  type ScheduleJobRef,
} from '@velajs/vela';
import { Process, Processor, QueueModule, dispatchQueueJob, queueToken } from '@velajs/vela/queue';
import {
  cloudflareAdapter,
  createCloudflareApp,
  createCloudflareWorker,
} from '../cloudflare-factory';
import { cloudflareQueues } from '../queues';

const env = { NAME: 'signed' };
const context = { waitUntil() {} };
const signed = { kind: 'signed', target: () => ({ route: 'jobs.run' }) } as const;

beforeEach(() => {
  MetadataRegistry.clear();
});

function signingSecret() {
  @Global()
  @Module({
    providers: [defineProvider(URL_SIGNING_SECRET, { useValue: 'signed-dispatch-test-secret' })],
    exports: [URL_SIGNING_SECRET],
  })
  class SecretModule {}
  return SecretModule;
}

describe('signed queue dispatch on Cloudflare', () => {
  function queueApp() {
    const seen: string[] = [];

    class GlobalGuard implements CanActivate {
      canActivate(execution: ExecutionContext): boolean {
        seen.push(`guard:${execution.getType()}`);
        return true;
      }
    }

    @Controller('/jobs')
    class JobsController {
      @Post('run', { name: 'jobs.run' })
      @SignedInvocation()
      run(): { ok: boolean } {
        seen.push('route');
        return { ok: true };
      }
    }

    @Processor('tasks')
    class Tasks {
      @Process('run')
      run(): void {
        seen.push('processor');
      }
    }

    @Module({
      imports: [
        signingSecret(),
        QueueModule.forRoot({ driver: cloudflareQueues(), dispatch: signed }),
        QueueModule.registerQueue({ name: 'tasks', binding: 'TASKS' }),
      ],
      controllers: [JobsController],
      providers: [Tasks, defineProvider(APP_GUARD, { useClass: GlobalGuard })],
    })
    class App {}
    return { App, seen };
  }

  it('re-enters the signed route with its global guards for natively delivered jobs', async () => {
    const { App, seen } = queueApp();
    const message = {
      id: 'message-1',
      timestamp: new Date(),
      attempts: 1,
      body: { id: 'job-1', queue: 'tasks', name: 'run', data: {}, attempt: 1 },
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const worker = createCloudflareWorker(App);
    await worker.queue({ queue: 'tasks-native', messages: [message] }, env, context);

    expect(seen).toEqual(['guard:http', 'route']);
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('keeps the global guard in front of jobs a custom transport dispatches', async () => {
    const seen: string[] = [];
    class Deny implements CanActivate {
      canActivate(): boolean {
        seen.push('guard');
        return false;
      }
    }
    @Controller('/jobs')
    class JobsController {
      @Post('run', { name: 'jobs.run' })
      @SignedInvocation()
      run(): { ok: boolean } {
        seen.push('route');
        return { ok: true };
      }
    }
    @Processor('tasks')
    class Tasks {
      @Process('run')
      run(): void {
        seen.push('processor');
      }
    }
    @Module({
      imports: [
        signingSecret(),
        QueueModule.forRoot({ driver: cloudflareQueues(), dispatch: signed }),
        QueueModule.registerQueue({ name: 'tasks' }),
      ],
      controllers: [JobsController],
      providers: [Tasks, defineProvider(APP_GUARD, { useClass: Deny })],
    })
    class App {}
    const app = await VelaFactory.create(App, { adapters: [cloudflareAdapter({ env })] });
    try {
      // A transport other than Cloudflare Queues hands each job to dispatchQueueJob,
      // which applies the module's signed policy.
      await expect(
        dispatchQueueJob(app.getContainer(), app.entrypoints, {
          id: 'job-1',
          queue: 'tasks',
          name: 'run',
          data: {},
          attempt: 1,
        }),
      ).rejects.toThrow();
      expect(seen).toEqual(['guard']);
    } finally {
      await app.close();
    }
  });

  it('boots signed dispatch in a Worker that only produces the queue', async () => {
    const { App, seen } = queueApp();
    const send = vi.fn(async () => {});
    const app = await createCloudflareApp(App, { env: { ...env, TASKS: { send } } });
    try {
      await app.get(queueToken('tasks')).add('run', {});
      expect(send).toHaveBeenCalledOnce();
      expect(seen).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe('signed schedule dispatch on Cloudflare', () => {
  function scheduledApp(kind: 'signed' | 'direct') {
    const seen: string[] = [];
    const jobs: ScheduleJobRef[] = [];

    class GlobalGuard implements CanActivate {
      canActivate(execution: ExecutionContext): boolean {
        seen.push(`guard:${execution.getType()}`);
        return true;
      }
    }

    @Controller('/jobs')
    class JobsController {
      @Post('tick')
      @SignedInvocation()
      tick(): { ok: boolean } {
        seen.push('route');
        return { ok: true };
      }
    }

    @Injectable()
    class Ticker {
      @Cron('* * * * *', { dialect: 'cloudflare' })
      tick(): void {
        seen.push('direct');
      }
    }

    @Module({
      imports: [
        signingSecret(),
        ScheduleModule.forRoot({
          dispatch:
            kind === 'signed'
              ? {
                  kind,
                  target: (job) => {
                    jobs.push(job);
                    return { path: '/jobs/tick' };
                  },
                }
              : { kind },
        }),
      ],
      controllers: [JobsController],
      providers: [Ticker, defineProvider(APP_GUARD, { useClass: GlobalGuard })],
    })
    class App {}
    return { App, seen, jobs };
  }

  it('re-enters the signed route with its global guards for a cron trigger', async () => {
    const { App, seen, jobs } = scheduledApp('signed');
    const worker = createCloudflareWorker(App);

    await worker.scheduled({ cron: '* * * * *' }, env, context);

    expect(seen).toEqual(['guard:http', 'route']);
    expect(jobs).toEqual([{ kind: 'cron', expression: '* * * * *', methodName: 'tick' }]);
  });

  it('honors signed dispatch in applications composed with cloudflareAdapter', async () => {
    const { App, seen } = scheduledApp('signed');
    const app = await createCloudflareApp(App, { env });
    try {
      await app.scheduled({ cron: '* * * * *' }, env, context);
      expect(seen).toEqual(['guard:http', 'route']);
    } finally {
      await app.close();
    }
    const composed = await VelaFactory.create(App, { adapters: [cloudflareAdapter({ env })] });
    await composed.close();
  });

  it('keeps direct schedule dispatch free of the HTTP pipeline', async () => {
    const { App, seen } = scheduledApp('direct');
    const app = await createCloudflareApp(App, { env });

    await app.scheduled({ cron: '* * * * *' }, env, context);

    expect(seen).toEqual(['direct']);
    await app.close();
  });
});
