import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
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
  function scheduledApp(dispatch?: Parameters<typeof ScheduleModule.forRoot>[0]) {
    const ticks: string[] = [];

    @Injectable()
    class Ticker {
      @Cron('* * * * *', { dialect: 'cloudflare' })
      tick(): void {
        ticks.push('tick');
      }
    }

    @Module({
      imports: [signingSecret(), ScheduleModule.forRoot(dispatch)],
      providers: [Ticker],
    })
    class App {}
    return { App, ticks };
  }

  it('rejects signed ScheduleModule dispatch at bootstrap with guidance', async () => {
    const { App, ticks } = scheduledApp({ dispatch: signed });

    await expect(createCloudflareApp(App, { env })).rejects.toThrow(
      /signed ScheduleModule dispatch.*not supported by the Cloudflare adapter.*InternalDispatcher/,
    );
    expect(ticks).toEqual([]);
  });

  it('applies the rejection to applications composed with cloudflareAdapter', async () => {
    const { App } = scheduledApp({ dispatch: signed });

    await expect(
      VelaFactory.create(App, { adapters: [cloudflareAdapter({ env })] }),
    ).rejects.toThrow(/signed ScheduleModule dispatch/);
  });

  it('keeps direct schedule dispatch available', async () => {
    const { App, ticks } = scheduledApp({ dispatch: { kind: 'direct' } });
    const app = await createCloudflareApp(App, { env });

    await app.scheduled({ cron: '* * * * *' }, env, context);

    expect(ticks).toEqual(['tick']);
    await app.close();
  });
});
