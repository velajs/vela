import { defineProvider } from '../container/types';
import { describe, it, expect, vi } from 'vitest';
import {
  VelaFactory,
  Module,
  Global,
  Controller,
  Post,
  Injectable,
  SignedInvocation,
  URL_SIGNING_SECRET,
} from '../index.js';
import {
  ScheduleModule,
  Interval,
  SCHEDULE_DISPATCH,
  type ScheduleDispatchMode,
  type ScheduleJobRef,
} from '../schedule/index.js';
import { ScheduleNodeModule } from '../schedule-node/index.js';

const SECRET = 'schedule-signed-dispatch-secret';

/** Builds a signed policy per path: every policy has the same source. */
function signedTo(path: string): ScheduleDispatchMode {
  return { kind: 'signed', target: () => ({ path }) };
}

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

  it('fails bootstrap when forRoot configures two different dispatch policies', async () => {
    const signed = { kind: 'signed', target: () => ({ path: '/tick' }) } as const;

    @Module({ imports: [ScheduleModule.forRoot({ dispatch: signed })] })
    class FeatureModule {}

    @Module({ imports: [ScheduleModule.forRoot({ dispatch: { kind: 'direct' } }), FeatureModule] })
    class AppModule {}

    await expect(VelaFactory.create(AppModule)).rejects.toThrow(
      /ScheduleModule\.forRoot\(\) is imported with different dispatch policies/,
    );

    // The same policy imported twice deduplicates into one owner.
    @Module({
      imports: [
        ScheduleModule.forRoot({ dispatch: signed }),
        ScheduleModule.forRoot({ dispatch: signed }),
      ],
    })
    class SameModule {}
    const app = await VelaFactory.create(SameModule);
    await app.close();
  });

  it('fails bootstrap when two signed forRoot policies re-enter different targets', async () => {
    @Module({
      imports: [
        ScheduleModule.forRoot({
          dispatch: { kind: 'signed', target: () => ({ path: '/jobs/feature' }) },
        }),
      ],
    })
    class FeatureModule {}

    @Module({
      imports: [
        ScheduleModule.forRoot({
          dispatch: { kind: 'signed', target: () => ({ path: '/jobs/root' }) },
        }),
        FeatureModule,
      ],
    })
    class AppModule {}

    await expect(VelaFactory.create(AppModule, { diagnostics: 'silent' })).rejects.toThrow(
      /ScheduleModule\.forRoot\(\) is imported with different dispatch policies/,
    );

    // A signed policy that differs only in its request options conflicts too.
    const target = () => ({ path: '/jobs/run' });
    @Module({
      imports: [
        ScheduleModule.forRoot({ dispatch: { kind: 'signed', target, ttlSeconds: 30 } }),
        ScheduleModule.forRoot({ dispatch: { kind: 'signed', target, ttlSeconds: 60 } }),
      ],
    })
    class TtlModule {}
    await expect(VelaFactory.create(TtlModule, { diagnostics: 'silent' })).rejects.toThrow(
      /different dispatch policies/,
    );
  });

  it('fails bootstrap on helper-built policies with one source but different targets', async () => {
    @Module({ imports: [ScheduleModule.forRoot({ dispatch: signedTo('/jobs/feature') })] })
    class FeatureModule {}

    @Module({
      imports: [ScheduleModule.forRoot({ dispatch: signedTo('/jobs/root') }), FeatureModule],
    })
    class AppModule {}

    await expect(VelaFactory.create(AppModule, { diagnostics: 'silent' })).rejects.toThrow(
      /ScheduleModule\.forRoot\(\) is imported with different dispatch policies/,
    );

    // One policy object imported again deduplicates into one owner.
    const policy = signedTo('/jobs/root');
    @Module({
      imports: [
        ScheduleModule.forRoot({ dispatch: policy }),
        ScheduleModule.forRoot({ dispatch: policy }),
      ],
    })
    class SameModule {}
    const app = await VelaFactory.create(SameModule);
    expect(app.getContainer().getOwnerModuleIds(SCHEDULE_DISPATCH)).toHaveLength(1);
    await app.close();
  });
});
