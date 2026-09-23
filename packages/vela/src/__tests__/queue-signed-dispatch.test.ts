import { defineProvider } from '../container/types';
import { describe, it, expect } from 'vitest';
import {
  APP_GUARD,
  VelaFactory,
  Module,
  Global,
  Controller,
  Post,
  Inject,
  Injectable,
  SignedInvocation,
  URL_SIGNING_SECRET,
  type CanActivate,
} from '../index.js';
import {
  QueueDispatchBinding,
  QueueModule,
  Process,
  Processor,
  dispatchQueueJob,
  queueToken,
  inline,
} from '../queue/index.js';
import type { QueueClient, QueueDriver, QueueJob } from '../queue/index.js';

const SECRET = 'queue-signed-dispatch-secret';

describe('QueueModule signed re-entry dispatch (opt-in)', () => {
  it('signed mode re-enters a @SignedInvocation() route instead of the @Processor', async () => {
    const routeHits: string[] = [];
    const processorHits: string[] = [];
    const driver = inline({ mode: 'manual' });

    @Global()
    @Module({
      providers: [defineProvider(URL_SIGNING_SECRET, { useValue: SECRET })],
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
          driver,
          dispatch: { kind: 'signed', target: () => ({ route: 'inv.run' }) },
        }),
        QueueModule.registerQueue({ name: 'signed-q' }),
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
      imports: [QueueModule.forRoot({ driver }), QueueModule.registerQueue({ name: 'direct-q' })],
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
          driver,
          dispatch: { kind: 'direct' },
        }),
        QueueModule.registerQueue({ name: 'explicit-direct-q' }),
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

  it('re-enters the signed route for jobs a platform consumer delivers through the module', async () => {
    const routeHits: string[] = [];
    const processorHits: string[] = [];
    // Producer-only here: the platform hands received jobs to QueueDispatchBinding.
    const sent: QueueJob[] = [];
    const driver: QueueDriver = {
      kind: 'native',
      async enqueue(job) {
        sent.push(job);
      },
    };

    @Global()
    @Module({
      providers: [defineProvider(URL_SIGNING_SECRET, { useValue: SECRET })],
      exports: [URL_SIGNING_SECRET],
    })
    class SecretModule {}

    @Controller('/q-native')
    class NativeController {
      @Post('run', { name: 'native.run' })
      @SignedInvocation()
      run(): { ok: boolean } {
        routeHits.push('run');
        return { ok: true };
      }
    }

    @Processor('native-q')
    @Injectable()
    class NativeProcessor {
      @Process('go')
      go(): void {
        processorHits.push('go');
      }
    }

    @Module({
      imports: [
        SecretModule,
        QueueModule.forRoot({
          driver,
          dispatch: { kind: 'signed', target: () => ({ route: 'native.run' }) },
        }),
        QueueModule.registerQueue({ name: 'native-q' }),
      ],
      controllers: [NativeController],
      providers: [NativeProcessor],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const job = await app.get(queueToken('native-q')).add('go', {});
    expect(sent).toEqual([job]);
    await app.get(QueueDispatchBinding).dispatch({ ...job, attempt: 2 });

    expect(routeHits).toEqual(['run']);
    expect(processorHits).toEqual([]);
    await app.close();
  });

  it('dispatchQueueJob honors the signed policy, so a custom transport cannot bypass global guards', async () => {
    const seen: string[] = [];
    class Deny implements CanActivate {
      canActivate(): boolean {
        seen.push('guard');
        return false;
      }
    }

    @Global()
    @Module({
      providers: [defineProvider(URL_SIGNING_SECRET, { useValue: SECRET })],
      exports: [URL_SIGNING_SECRET],
    })
    class SecretModule {}

    @Controller('/q-custom')
    class CustomController {
      @Post('run', { name: 'custom.run' })
      @SignedInvocation()
      run(): { ok: boolean } {
        seen.push('route');
        return { ok: true };
      }
    }

    @Processor('custom-q')
    @Injectable()
    class CustomProcessor {
      @Process('go')
      go(): void {
        seen.push('processor');
      }
    }

    @Module({
      imports: [
        SecretModule,
        QueueModule.forRoot({
          driver: inline({ mode: 'manual' }),
          dispatch: { kind: 'signed', target: () => ({ route: 'custom.run' }) },
        }),
        QueueModule.registerQueue({ name: 'custom-q' }),
      ],
      controllers: [CustomController],
      providers: [CustomProcessor, defineProvider(APP_GUARD, { useClass: Deny })],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, { diagnostics: 'silent' });
    try {
      const job = { id: 'custom-1', queue: 'custom-q', name: 'go', data: {}, attempt: 1 };
      await expect(dispatchQueueJob(app.getContainer(), app.entrypoints, job)).rejects.toThrow();
      // The global guard rejected the signed re-entry; the processor never ran directly.
      expect(seen).toEqual(['guard']);
      // The module's registration contract applies to the low-level entry too.
      await expect(
        dispatchQueueJob(app.getContainer(), app.entrypoints, { ...job, queue: 'unregistered' }),
      ).rejects.toThrow(/not registered/);
    } finally {
      await app.close();
    }
  });

  it('dispatchQueueJob reports the signed re-entry as the handled delivery', async () => {
    const seen: string[] = [];

    @Global()
    @Module({
      providers: [defineProvider(URL_SIGNING_SECRET, { useValue: SECRET })],
      exports: [URL_SIGNING_SECRET],
    })
    class SecretModule {}

    @Controller('/q-allowed')
    class AllowedController {
      @Post('run', { name: 'allowed.run' })
      @SignedInvocation()
      run(): { ok: boolean } {
        seen.push('route');
        return { ok: true };
      }
    }

    @Module({
      imports: [
        SecretModule,
        QueueModule.forRoot({
          driver: inline({ mode: 'manual' }),
          dispatch: { kind: 'signed', target: () => ({ route: 'allowed.run' }) },
        }),
        QueueModule.registerQueue({ name: 'allowed-q' }),
      ],
      controllers: [AllowedController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    try {
      const job = { id: 'allowed-1', queue: 'allowed-q', name: 'go', data: {}, attempt: 1 };
      await expect(dispatchQueueJob(app.getContainer(), app.entrypoints, job)).resolves.toEqual({
        handled: 1,
      });
      await expect(app.get(QueueDispatchBinding).dispatch(job)).resolves.toEqual({ handled: 1 });
      expect(seen).toEqual(['route', 'route']);
    } finally {
      await app.close();
    }
  });
});
