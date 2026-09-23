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
import { Process, Processor, QueueModule } from '@velajs/vela/queue';
import {
  cloudflareAdapter,
  createCloudflareApp,
  createCloudflareWorker,
} from '../cloudflare-factory';
import { cloudflareQueueDriver } from '../queue';

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
  it('re-enters the signed route for batches the module consumes natively', async () => {
    const routeHits: string[] = [];
    const processorHits: string[] = [];

    @Controller('/jobs')
    class JobsController {
      @Post('run', { name: 'jobs.run' })
      @SignedInvocation()
      run(): { ok: boolean } {
        routeHits.push('run');
        return { ok: true };
      }
    }

    @Processor('tasks')
    @Injectable()
    class Tasks {
      @Process('run')
      run(): void {
        processorHits.push('run');
      }
    }

    @Module({
      imports: [
        signingSecret(),
        QueueModule.forRoot({
          queues: ['tasks'],
          driver: () => cloudflareQueueDriver({}, { consumers: { 'tasks-native': 'tasks' } }),
          dispatch: signed,
        }),
      ],
      controllers: [JobsController],
      providers: [Tasks],
    })
    class App {}

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

    expect(routeHits).toEqual(['run']);
    expect(processorHits).toEqual([]);
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('rejects signed dispatch when the driver has no consumer mapping', async () => {
    const send = vi.fn(async () => {});

    @Module({
      imports: [
        QueueModule.forRoot({
          queues: ['tasks'],
          driver: cloudflareQueueDriver({ tasks: { send } }),
          dispatch: signed,
        }),
      ],
    })
    class App {}

    await expect(createCloudflareApp(App, { env })).rejects.toThrow(
      /signed dispatch for queue 'tasks'.*driver 'cloudflare' implements neither bind\(\) nor consume\(\)/,
    );
    expect(send).not.toHaveBeenCalled();
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
