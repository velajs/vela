import { defineProvider } from '../container/types';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  VelaFactory,
  Module,
  Global,
  Controller,
  Post,
  Inject,
  MetadataRegistry,
  SignedInvocation,
  InternalDispatcher,
  URL_SIGNING_SECRET,
  APP_EXCEPTION_HANDLER,
  BadRequestException,
  InternalServerErrorException,
  isVelaError,
} from '../index.js';
import { dispatchQueueJob, Process, Processor } from '../queue/index.js';
import type { QueueJob } from '../queue/index.js';

const SECRET = 'adopter-signing-secret';

// Observability ledger: proves the re-entered route ran in THIS isolate.
const routeHits: string[] = [];
// Where the processor stashes what its in-app `ctx.run` returned.
const runResults: Array<{ ran: boolean }> = [];

beforeEach(() => {
  MetadataRegistry.clear();
  routeHits.length = 0;
  runResults.length = 0;
});

@Global()
@Module({
  providers: [
    defineProvider(URL_SIGNING_SECRET, { useValue: SECRET }),
    // Silence the report-first edge for the deliberate 5xx route.
    defineProvider(APP_EXCEPTION_HANDLER, { useValue: { report() {} } }),
  ],
  exports: [URL_SIGNING_SECRET, APP_EXCEPTION_HANDLER],
})
class SecretModule {}

@Controller('/inv')
class InvController {
  @Post('run', { name: 'inv.run' })
  @SignedInvocation()
  run() {
    routeHits.push('run');
    return { ran: true };
  }

  @Post('boom4', { name: 'inv.boom4' })
  @SignedInvocation()
  boom4(): never {
    throw new BadRequestException('deterministic input error');
  }

  @Post('boom5', { name: 'inv.boom5' })
  @SignedInvocation()
  boom5(): never {
    throw new InternalServerErrorException('transient upstream error');
  }
}

@Processor('reenter-q')
class ReentryProcessor {
  constructor(@Inject(InternalDispatcher) private readonly dispatcher: InternalDispatcher) {}

  @Process('go')
  async go(job: QueueJob) {
    // The adoption: a queue handler re-enters a signed app route in-isolate.
    const result = await this.dispatcher.run<{ ran: boolean }>(
      { route: 'inv.run' },
      { body: { job: job.name }, iss: 'reenter-q' },
    );
    runResults.push(result);
  }
}

@Module({
  imports: [SecretModule],
  controllers: [InvController],
  providers: [ReentryProcessor],
})
class AppModule {}

describe('InternalDispatcher adoption — queue @Processor re-enters a signed route', () => {
  it('re-enters a @SignedInvocation() route in-isolate from a queue handler', async () => {
    const app = await VelaFactory.create(AppModule);

    const result = await dispatchQueueJob(app.getContainer(), app.entrypoints, {
      id: 'job-1',
      queue: 'reenter-q',
      name: 'go',
      data: {},
      attempt: 1,
    });

    expect(result.handled).toBe(1);
    // The signed request passed the guard and the route ran in the same isolate.
    expect(routeHits).toEqual(['run']);
    expect(runResults).toEqual([{ ran: true }]);
    await app.dispose();
  });

  it('reconstructs a 4xx as a non-retryable VelaError (deterministic)', async () => {
    const app = await VelaFactory.create(AppModule);
    const dispatcher = app.get(InternalDispatcher);

    const err = await dispatcher.run({ route: 'inv.boom4' }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(isVelaError(err)).toBe(true);
    if (isVelaError(err)) {
      expect(err.status).toBe(400);
      expect(err.status >= 400 && err.status < 500).toBe(true); // caller: do NOT retry
    }
    await app.dispose();
  });

  it('reconstructs a 5xx as a retryable VelaError (transient)', async () => {
    const app = await VelaFactory.create(AppModule);
    const dispatcher = app.get(InternalDispatcher);

    const err = await dispatcher.run({ route: 'inv.boom5' }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(isVelaError(err)).toBe(true);
    if (isVelaError(err)) {
      expect(err.status).toBe(500);
      expect(err.status >= 500).toBe(true); // caller: safe to retry
    }
    await app.dispose();
  });
});
