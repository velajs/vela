import { defineProvider } from '../container/types';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  VelaFactory,
  Module,
  Global,
  Controller,
  Post,
  Injectable,
  MetadataRegistry,
  SignedInvocation,
  URL_SIGNING_SECRET,
} from '../index.js';
import { ScheduleModule, Interval, type ScheduleJobRef } from '../schedule/index.js';
import { ScheduleNodeModule } from '../schedule-node/index.js';

const SECRET = 'schedule-signed-dispatch-secret';

beforeEach(() => {
  MetadataRegistry.clear();
});

/** Poll until `predicate` holds or the deadline passes (real timers). */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('ScheduleModule signed re-entry dispatch (opt-in)', () => {
  // Real timers (not fake): the signed path awaits real `crypto.subtle`, which
  // fake timers cannot reliably flush inside the executor's detached dispatch.
  it('signed mode re-enters a route when a scheduled job fires (direct method bypassed)', async () => {
    const routeHits: string[] = [];
    const jobs: ScheduleJobRef[] = [];
    let directCalls = 0;

    @Global()
    @Module({
      providers: [defineProvider(URL_SIGNING_SECRET, { useValue: SECRET })],
      exports: [URL_SIGNING_SECRET],
    })
    class SecretModule {}

    @Controller('/tick')
    class TickController {
      @Post('run', { name: 'inv.tick' })
      @SignedInvocation()
      run(): { ok: boolean } {
        routeHits.push('tick');
        return { ok: true };
      }
    }

    @Injectable()
    class Ticker {
      @Interval(20)
      tick(): void {
        // In signed mode the executor must NOT call this method directly —
        // asserted below via `directCalls === 0`.
        directCalls++;
      }
    }

    @Module({
      imports: [
        SecretModule,
        ScheduleModule.forRoot({
          dispatch: {
            kind: 'signed',
            target: (job) => {
              jobs.push(job);
              return { route: 'inv.tick' };
            },
          },
        }),
        ScheduleNodeModule.forRoot(),
      ],
      controllers: [TickController],
      providers: [Ticker],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await waitUntil(() => routeHits.length > 0);
    await app.close();

    // The fired job re-entered the signed route, not the decorated method.
    expect(routeHits.length).toBeGreaterThanOrEqual(1);
    expect(routeHits.every((hit) => hit === 'tick')).toBe(true);
    expect(directCalls).toBe(0);
    expect(jobs[0]).toEqual({ kind: 'interval', ms: 20, methodName: 'tick' });
  });

  it('default forRoot() calls the decorated method directly (unchanged)', async () => {
    vi.useFakeTimers();
    let directCalls = 0;

    @Injectable()
    class Ticker {
      @Interval(100)
      tick(): void {
        directCalls++;
      }
    }

    @Module({
      imports: [ScheduleNodeModule.forRoot()],
      providers: [Ticker],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await vi.advanceTimersByTimeAsync(350);

    expect(directCalls).toBeGreaterThanOrEqual(1);

    await app.close();
    vi.useRealTimers();
  });
});
