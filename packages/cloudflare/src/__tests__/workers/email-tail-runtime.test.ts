// @ts-expect-error virtual module supplied by @cloudflare/vitest-plugin
import * as cloudflareTest from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  APP_EXCEPTION_HANDLER,
  Inject,
  InjectEnv,
  InjectionToken,
  Injectable,
  Module,
  defineProvider,
  type VelaEnv,
} from '@velajs/vela';
import { defineCloudflareApp } from '../../index';
import { OnEmail, UNCLAIMED_EMAIL_REASON } from '../../email';
import { OnTail } from '../../tail';
import { createTestingWorker, emailMessage, traceItem } from '../../testing';

/** The `cloudflare:test` helpers these specs drive. */
interface WorkersTestPool {
  createExecutionContext(): ExecutionContext;
  waitOnExecutionContext(ctx: ExecutionContext): Promise<void>;
}
const pool: WorkersTestPool = cloudflareTest;

const SEEN = new InjectionToken<string[]>('seen');

@Injectable()
class Inbox {
  constructor(
    @InjectEnv() private readonly bindings: VelaEnv,
    @Inject(SEEN) private readonly seen: string[],
  ) {}

  @OnEmail({ to: 'support@example.com' })
  async support(message: ForwardableEmailMessage): Promise<void> {
    const body = await new Response(message.raw).text();
    this.seen.push(`support:${message.headers.get('subject')}:${body.includes('printer')}`);
    await message.forward(`team@${this.bindings.ENV_PROBE}.example.com`);
  }

  @OnEmail({ to: 'broken@example.com' })
  broken(): never {
    throw new Error('mailbox store unavailable');
  }
}

@Injectable()
class Observer {
  constructor(@Inject(SEEN) private readonly seen: string[]) {}

  @OnTail()
  observe(events: TraceItem[]): void {
    for (const event of events) this.seen.push(`tail:${event.scriptName}:${event.outcome}`);
  }

  @OnTail()
  failing(): never {
    throw new Error('tail sink unreachable');
  }
}

@Module({
  providers: [Inbox, Observer, defineProvider(SEEN, { useFactory: () => [], inject: [] })],
})
class MailModule {}

describe('email and tail handlers under workerd', () => {
  it('delivers email through the Worker email handler and rejects what no handler accepts', async () => {
    const reports: unknown[] = [];
    const app = defineCloudflareApp(MailModule, {
      adapters: [
        {
          name: 'reports',
          configureContainer(container) {
            container.register(
              defineProvider(APP_EXCEPTION_HANDLER, {
                useValue: { report: (error: unknown) => void reports.push(error) },
              }),
            );
          },
        },
      ],
    });
    const email = app.worker.email;
    if (!email) throw new Error('The Worker has no email handler');
    const ctx = pool.createExecutionContext();

    const support = emailMessage({
      from: 'ada@example.net',
      to: 'support@example.com',
      subject: 'Help',
      text: 'The printer is on fire.',
    });
    await email(support, env, ctx);
    expect(support.forwards).toEqual([{ rcptTo: 'team@workerd-env.example.com' }]);
    expect(support.rejectReason).toBeUndefined();

    const unknown = emailMessage({ from: 'ada@example.net', to: 'nobody@example.com' });
    await email(unknown, env, ctx);
    expect(unknown.rejectReason).toBe(UNCLAIMED_EMAIL_REASON);

    const broken = emailMessage({ from: 'ada@example.net', to: 'broken@example.com' });
    await expect(email(broken, env, ctx)).rejects.toThrow('mailbox store unavailable');
    expect(reports.map(String)).toEqual(['Error: mailbox store unavailable']);

    // The tail handler never rejects into the platform's loop.
    const tail = app.worker.tail;
    if (!tail) throw new Error('The Worker has no tail handler');
    await expect(tail([traceItem({ outcome: 'exception' })], env, ctx)).resolves.toBeUndefined();
    expect(reports.map(String)).toContain('Error: tail sink unreachable');
    await pool.waitOnExecutionContext(ctx);
  });

  it('drives email and tail through the testing Worker', async () => {
    const worker = await createTestingWorker(MailModule);
    const message = emailMessage({
      from: 'grace@example.net',
      to: 'SUPPORT@example.com',
      subject: 'Printer',
      text: 'printer jam',
    });
    await worker.email(message);
    await worker.tail([traceItem({ scriptName: 'api', outcome: 'ok' })]);
    expect(worker.module.get(SEEN)).toEqual(['support:Printer:true', 'tail:api:ok']);
    expect(message.forwards).toEqual([{ rcptTo: 'team@workerd-env.example.com' }]);
    await worker.close();
  });
});
