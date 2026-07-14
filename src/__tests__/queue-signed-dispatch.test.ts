import { describe, it, expect, beforeEach } from 'vitest';
import {
  VelaFactory,
  Module,
  Global,
  Controller,
  Post,
  Inject,
  Injectable,
  MetadataRegistry,
  SignedInvocation,
  URL_SIGNING_SECRET,
} from '../index.js';
import { QueueModule, Process, Processor, queueToken, inline } from '../queue/index.js';
import type { QueueClient, QueueJob } from '../queue/index.js';

const SECRET = 'queue-signed-dispatch-secret';

beforeEach(() => {
  MetadataRegistry.clear();
});

describe('QueueModule signed re-entry dispatch (opt-in)', () => {
  it('signed mode re-enters a @SignedInvocation() route instead of the @Processor', async () => {
    const routeHits: string[] = [];
    const processorHits: string[] = [];
    const driver = inline({ mode: 'manual' });

    @Global()
    @Module({
      providers: [{ provide: URL_SIGNING_SECRET, useValue: SECRET }],
      exports: [URL_SIGNING_SECRET],
    })
    class SecretModule {}

    @Controller('/q-inv')
    class QInvController {
      @Post('run', { name: 'inv.run' })
      @SignedInvocation()
      run(): { ok: boolean } {
        routeHits.push('run');
        return { ok: true };
      }
    }

    @Processor('signed-q')
    @Injectable()
    class SignedProcessor {
      @Process('go')
      go(job: QueueJob): void {
        processorHits.push(job.name);
      }
    }

    @Injectable()
    class Producer {
      constructor(@Inject(queueToken('signed-q')) readonly queue: QueueClient) {}
    }

    @Module({
      imports: [
        SecretModule,
        QueueModule.forRoot({
          queues: ['signed-q'],
          driver,
          dispatch: { kind: 'signed', target: () => ({ route: 'inv.run' }) },
        }),
      ],
      controllers: [QInvController],
      providers: [SignedProcessor, Producer],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.get(Producer).queue.add('go', { hello: 'world' });
    const delivered = await driver.flush();

    expect(delivered).toBe(1);
    // The signed request passed the guard and the route ran in-isolate.
    expect(routeHits).toEqual(['run']);
    // The direct @Processor path was NOT taken.
    expect(processorHits).toEqual([]);
    await app.close();
  });

  it('default (absent dispatch) still delivers to the @Processor via dispatchJobToEntries', async () => {
    const processorHits: string[] = [];
    const driver = inline({ mode: 'manual' });

    @Processor('direct-q')
    @Injectable()
    class DirectProcessor {
      @Process('go')
      go(job: QueueJob): void {
        processorHits.push(job.name);
      }
    }

    @Injectable()
    class Producer {
      constructor(@Inject(queueToken('direct-q')) readonly queue: QueueClient) {}
    }

    @Module({
      imports: [QueueModule.forRoot({ queues: ['direct-q'], driver })],
      providers: [DirectProcessor, Producer],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.get(Producer).queue.add('go', {});
    await driver.flush();

    expect(processorHits).toEqual(['go']);
    await app.close();
  });

  it('explicit { kind: "direct" } is identical to the default path', async () => {
    const processorHits: string[] = [];
    const driver = inline({ mode: 'manual' });

    @Processor('explicit-direct-q')
    @Injectable()
    class DirectProcessor {
      @Process('go')
      go(job: QueueJob): void {
        processorHits.push(job.name);
      }
    }

    @Injectable()
    class Producer {
      constructor(@Inject(queueToken('explicit-direct-q')) readonly queue: QueueClient) {}
    }

    @Module({
      imports: [
        QueueModule.forRoot({
          queues: ['explicit-direct-q'],
          driver,
          dispatch: { kind: 'direct' },
        }),
      ],
      providers: [DirectProcessor, Producer],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.get(Producer).queue.add('go', {});
    await driver.flush();

    expect(processorHits).toEqual(['go']);
    await app.close();
  });
});
