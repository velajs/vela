import { describe, expect, it } from 'vitest';
import {
  APP_EXCEPTION_HANDLER,
  Catch,
  ENV,
  Inject,
  InjectionToken,
  Injectable,
  Module,
  Scope,
  UseFilters,
  UseGuards,
  defineProvider,
  type CanActivate,
  type ErrorReportContext,
  type ExceptionFilter,
  type VelaEnv,
} from '@velajs/vela';
import type { EntrypointExecutionContext, RuntimeAdapter } from '@velajs/vela/module-kit';
import { cloudflareApplication } from '../cloudflare-factory';
import { defineCloudflareApp, type CloudflareApp } from '../index';
import { OnEmail, UNCLAIMED_EMAIL_REASON } from '../email';
import { OnTail } from '../tail';

const REPORTS = new InjectionToken<{ error: unknown; context: ErrorReportContext }[]>('reports');

const reporting: RuntimeAdapter = {
  name: 'reports',
  configureContainer(container) {
    const reports: { error: unknown; context: ErrorReportContext }[] = [];
    container.register(defineProvider(REPORTS, { useValue: reports }));
    container.markGlobalToken(REPORTS);
    container.register(
      defineProvider(APP_EXCEPTION_HANDLER, {
        useValue: { report: (error: unknown, context) => void reports.push({ error, context }) },
      }),
    );
  },
};

async function reportsOf(
  app: CloudflareApp,
  env: VelaEnv,
): Promise<{ error: unknown; context: ErrorReportContext }[]> {
  return (await cloudflareApplication(app, env)).get(REPORTS);
}

/** An Email Workers message that records what its handlers did with it. */
interface RecordedEmail extends ForwardableEmailMessage {
  readonly rejected: string[];
  readonly forwarded: string[];
}

function email(to: string, from = 'sender@example.net'): RecordedEmail {
  const rejected: string[] = [];
  const forwarded: string[] = [];
  const raw = `From: ${from}\r\nTo: ${to}\r\nSubject: Hello\r\n\r\nBody`;
  return {
    from,
    to,
    raw: new Response(raw).body ?? new ReadableStream(),
    headers: new Headers({ subject: 'Hello' }),
    rawSize: raw.length,
    rejected,
    forwarded,
    setReject(reason: string) {
      rejected.push(reason);
    },
    async forward(rcptTo: string) {
      forwarded.push(rcptTo);
      return { messageId: `forwarded-${forwarded.length}` };
    },
    async reply() {
      return { messageId: 'reply' };
    },
  };
}

function trace(outcome: string, scriptName = 'producer'): TraceItem {
  return {
    event: null,
    eventTimestamp: 0,
    logs: [],
    exceptions: [],
    diagnosticsChannelEvents: [],
    scriptName,
    outcome,
    executionModel: 'stateless',
    truncated: false,
    cpuTime: 1,
    wallTime: 1,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected a rejection');
}

describe('@OnEmail()', () => {
  it('gives the Worker an email handler that routes by envelope recipient', async () => {
    const handled: string[] = [];
    let scopes = 0;
    @Injectable({ scope: Scope.REQUEST })
    class Delivery {
      readonly id = ++scopes;
    }
    @Injectable()
    class Inbox {
      constructor(
        @Inject(Delivery) private readonly delivery: Delivery,
        @Inject(ENV) private readonly env: VelaEnv,
      ) {}

      @OnEmail({ to: ['Support@Example.com', 'help@example.com'] })
      async support(message: ForwardableEmailMessage): Promise<void> {
        handled.push(`support:${message.to}:${this.delivery.id}`);
        await message.forward(String(Reflect.get(this.env, 'TEAM')));
      }

      @OnEmail()
      everythingElse(message: ForwardableEmailMessage): void {
        handled.push(`other:${message.to}:${this.delivery.id}`);
      }
    }
    @Module({ providers: [Inbox, Delivery] })
    class AppModule {}
    const app = defineCloudflareApp(AppModule);
    const env = { TEAM: 'team@example.com' };
    const handler = app.worker.email;
    if (!handler) throw new Error('The Worker has no email handler');

    const support = email('support@example.com');
    await handler(support, env);
    expect(support.forwarded).toEqual(['team@example.com']);
    const other = email('sales@example.com');
    await handler(other, env);
    expect(handled).toEqual(['support:support@example.com:1', 'other:sales@example.com:2']);
    expect(support.rejected).toEqual([]);
    expect(other.rejected).toEqual([]);
  });

  it('rejects a message no handler accepts instead of dropping it', async () => {
    @Injectable()
    class Addressed {
      @OnEmail({ to: 'billing@example.com' })
      receive(): void {}
    }
    @Module({ providers: [Addressed] })
    class AppModule {}
    const app = defineCloudflareApp(AppModule);
    const message = email('unknown@example.com');
    const warnings: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      await app.worker.email?.(message, {});
    } finally {
      console.warn = original;
    }
    expect(message.rejected).toEqual([UNCLAIMED_EMAIL_REASON]);
    expect(String(warnings[0])).toContain('no @OnEmail() handler accepts');

    // An application without any @OnEmail() handler rejects every message too.
    @Module({})
    class EmptyModule {}
    const empty = defineCloudflareApp(EmptyModule, {});
    const unrouted = email('anyone@example.com');
    console.warn = () => {};
    try {
      await empty.worker.email?.(unrouted, {});
    } finally {
      console.warn = original;
    }
    expect(unrouted.rejected).toEqual([UNCLAIMED_EMAIL_REASON]);
  });

  it('runs guards and filters, reports failures and rethrows them for the platform', async () => {
    const seen: EntrypointExecutionContext[] = [];
    @Injectable()
    class Observe implements CanActivate {
      canActivate(context: EntrypointExecutionContext): boolean {
        seen.push(context);
        return true;
      }
    }
    @Catch(RangeError)
    class RejectFilter implements ExceptionFilter {
      catch(_error: unknown, context: EntrypointExecutionContext): void {
        const message = context.getPayload();
        if (typeof message === 'object' && message !== null) {
          Reflect.apply(Reflect.get(message, 'setReject'), message, ['Mailbox full']);
        }
      }
    }
    @UseGuards(Observe)
    @Injectable()
    class Inbox {
      @OnEmail({ to: 'full@example.com' })
      @UseFilters(RejectFilter)
      full(): void {
        throw new RangeError('quota');
      }

      @OnEmail({ to: 'broken@example.com' })
      broken(): void {
        throw new Error('database down');
      }
    }
    @Module({ providers: [Inbox, Observe] })
    class AppModule {}
    const app = defineCloudflareApp(AppModule, { adapters: [reporting] });
    const env = {};

    const full = email('full@example.com');
    await app.worker.email?.(full, env);
    expect(full.rejected).toEqual(['Mailbox full']);
    const [context] = seen;
    expect(context?.getType()).toBe('cf:email');
    expect(context?.getClass()).toBe(Inbox);
    expect(context?.getPayload()).toBe(full);

    const error = await rejection(
      Promise.resolve(app.worker.email?.(email('broken@example.com'), env)),
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('database down');
    expect((await reportsOf(app, env)).map(({ context: report }) => report)).toMatchObject([
      { edge: 'email', source: 'Inbox.full', kind: 'cf:email' },
      { edge: 'email', source: 'Inbox.broken', kind: 'cf:email' },
    ]);
  });

  it('validates its options when a method is decorated', () => {
    expect(() => OnEmail({ to: [] })).toThrow('non-empty list');
    expect(() => OnEmail({ to: 'not-an-address' })).toThrow('takes email addresses');
  });
});

describe('@OnTail()', () => {
  it('gives the Worker a tail handler whose failures are reported, never thrown', async () => {
    const observed: string[] = [];
    @Injectable()
    class Alerts {
      @OnTail()
      failures(events: TraceItem[]): void {
        observed.push(...events.filter((event) => event.outcome !== 'ok').map((e) => e.outcome));
      }
    }
    @Injectable()
    class Broken {
      @OnTail()
      explode(): never {
        throw new Error('tail sink unreachable');
      }
    }
    @Module({ providers: [Alerts, Broken] })
    class AppModule {}
    const app = defineCloudflareApp(AppModule, { adapters: [reporting] });
    const env = {};
    const handler = app.worker.tail;
    if (!handler) throw new Error('The Worker has no tail handler');

    await expect(handler([trace('ok'), trace('exception')], env)).resolves.toBeUndefined();
    expect(observed).toEqual(['exception']);
    const reports = await reportsOf(app, env);
    expect(reports.map(({ context }) => context)).toMatchObject([
      { edge: 'tail', source: 'Broken.explode', kind: 'cf:tail' },
    ]);
    expect(String(reports[0]?.error)).toContain('tail sink unreachable');
  });

  it('logs an application that fails to start and resolves, retrying on the next batch', async () => {
    let starts = 0;
    @Injectable()
    class Settings {
      onModuleInit(): void {
        starts += 1;
        if (starts === 1) throw new Error('config missing: SECRET_TOKEN');
      }
    }
    const observed: number[] = [];
    @Injectable()
    class Observer {
      @OnTail()
      observe(events: TraceItem[]): void {
        observed.push(events.length);
      }
    }
    @Module({ providers: [Settings, Observer] })
    class AppModule {}
    const app = defineCloudflareApp(AppModule);
    const env = {};
    const handler = app.worker.tail;
    if (!handler) throw new Error('The Worker has no tail handler');

    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      // No application, so no ExceptionHandler: the console is where it goes.
      await expect(handler([trace('exception')], env)).resolves.toBeUndefined();
    } finally {
      console.error = original;
    }
    expect(observed).toEqual([]);
    expect(logged).toHaveLength(1);
    expect(String(logged[0]?.[0])).toContain('tail');
    expect(logged[0]?.[1]).toBeInstanceOf(Error);
    expect(String(logged[0]?.[1])).toContain('config missing: SECRET_TOKEN');

    // The failed construction was evicted: the next batch builds the application.
    await expect(handler([trace('ok'), trace('ok')], env)).resolves.toBeUndefined();
    expect(observed).toEqual([2]);
  });
});
