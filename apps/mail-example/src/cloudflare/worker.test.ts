// @ts-expect-error Virtual module supplied by @cloudflare/vitest-plugin.
import * as cloudflareTest from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { createCloudflareWorker, type CloudflareApplication } from '@velajs/cloudflare';
import { buildMessage, MailService } from '@velajs/mail';
import { cloudflareEmailTransport } from '@velajs/mail/transports/cloudflare';
import { AppModule } from './worker';

interface WorkersTestPool {
  createExecutionContext(): ExecutionContext;
  waitOnExecutionContext(ctx: ExecutionContext): Promise<void>;
  createMessageBatch<Body>(
    queue: string,
    messages: { id: string; timestamp: Date; attempts: number; body: Body }[],
  ): MessageBatch<Body>;
  getQueueResult(batch: MessageBatch, ctx: ExecutionContext): Promise<{ explicitAcks: string[] }>;
}
const pool: WorkersTestPool = cloudflareTest;
const apps: CloudflareApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function incoming(to = 'support@example.com'): ForwardableEmailMessage {
  const headers = new Headers({
    from: 'untrusted@example.org',
    'reply-to': 'untrusted-reply@example.org',
    subject: 'Account help',
  });
  const bytes = new TextEncoder().encode(
    'From: untrusted@example.org\r\nReply-To: untrusted-reply@example.org\r\nSubject: Account help\r\n\r\nHello',
  );
  return {
    from: 'untrusted@example.org',
    to,
    headers,
    rawSize: bytes.length,
    raw: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    setReject() {},
    async forward() {
      throw new Error('This example must queue, not forward');
    },
    async reply() {
      throw new Error('This example must queue, not reply inline');
    },
  };
}

function fixture(label: string) {
  const sent: EmailMessageBuilder[] = [];
  const queued: unknown[] = [];
  let failure: unknown;
  const email: SendEmail = {
    async send(message: EmailMessage | EmailMessageBuilder): Promise<EmailSendResult> {
      if (failure !== undefined) throw failure;
      if (!('subject' in message)) throw new Error('Expected structured sending');
      sent.push(structuredClone(message));
      return { messageId: `${label}-${sent.length}` };
    },
  };
  const bindings: Env = {
    ...env,
    EMAIL: email,
    MAIL_QUEUE: {
      async send(body: unknown) {
        queued.push(structuredClone(body));
        return { metadata: { metrics: { backlogCount: queued.length, backlogBytes: 0 } } };
      },
      async sendBatch() {
        throw new Error('No bulk enqueue expected');
      },
      metrics: () => env.MAIL_QUEUE.metrics(),
    },
  };
  return {
    bindings,
    sent,
    queued,
    failWith: (cause: unknown) => {
      failure = cause;
    },
  };
}

function worker() {
  return createCloudflareWorker(AppModule, {
    configure(app) {
      apps.push(app);
    },
  });
}

async function consume(
  host: ReturnType<typeof worker>,
  bindings: Env,
  body: unknown,
  id = 'reply-1',
) {
  const batch = pool.createMessageBatch('mail-example-replies', [
    { id, timestamp: new Date(), attempts: 1, body },
  ]);
  const ctx = pool.createExecutionContext();
  let error: unknown;
  try {
    await host.queue(batch, bindings, ctx);
  } catch (cause) {
    error = cause;
  }
  const result = await pool.getQueueResult(batch, ctx);
  await pool.waitOnExecutionContext(ctx);
  return { ...result, error };
}

describe('native email and queued mail composition', () => {
  it('routes inbound email, queues a reply and submits only when the queue host consumes it', async () => {
    const state = fixture('email');
    const host = worker();
    const ctx = pool.createExecutionContext();
    if (!host.email) throw new Error('Missing native email handler');
    await host.email(incoming(), state.bindings, ctx);
    await pool.waitOnExecutionContext(ctx);
    expect(state.sent).toEqual([]);
    expect(state.queued).toHaveLength(1);
    const consumed = await consume(host, state.bindings, state.queued[0]);
    expect(consumed.error).toBeUndefined();
    expect(consumed.explicitAcks).toEqual(['reply-1']);
    expect(state.sent).toEqual([
      {
        from: 'support@example.com',
        to: ['reader@example.net'],
        replyTo: 'support@example.com',
        subject: 'Support request received',
        text: 'We received your request: Account help',
        headers: { 'Auto-Submitted': 'auto-replied' },
      },
    ]);
  });

  it('keeps concurrent environments isolated, including queue producers and transports', async () => {
    const first = fixture('first');
    const second = fixture('second');
    const host = worker();
    if (!host.email) throw new Error('Missing native email handler');
    const firstCtx = pool.createExecutionContext();
    const secondCtx = pool.createExecutionContext();
    await Promise.all([
      host.email(incoming(), first.bindings, firstCtx),
      host.email(incoming(), second.bindings, secondCtx),
    ]);
    await Promise.all([
      pool.waitOnExecutionContext(firstCtx),
      pool.waitOnExecutionContext(secondCtx),
    ]);
    expect(first.queued).toHaveLength(1);
    expect(second.queued).toHaveLength(1);
    await consume(host, second.bindings, second.queued[0]);
    expect(first.sent).toHaveLength(0);
    expect(second.sent).toHaveLength(1);
    await consume(host, first.bindings, first.queued[0]);
    expect(first.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(1);
  });

  it('rejects unsafe fields before enqueue and revalidates tampered jobs before sending', async () => {
    const state = fixture('guarded');
    const host = worker();
    if (!host.email) throw new Error('Missing native email handler');
    const ctx = pool.createExecutionContext();
    await host.email(incoming(), state.bindings, ctx);
    await pool.waitOnExecutionContext(ctx);
    const mailer = apps[0]!.get(MailService);
    await expect(
      mailer.queue({
        to: 'reader@example.net',
        subject: 'Bad\r\nBcc: extra@example.org',
        text: 'hello',
      }),
    ).rejects.toMatchObject({ code: 'invalid_header' });
    await expect(
      mailer.send({
        to: 'reader@example.net',
        subject: 'Hi',
        text: 'hello',
        replyTo: 'bad@example.net,extra@example.org',
      }),
    ).rejects.toMatchObject({ code: 'invalid_address' });
    expect(state.queued).toHaveLength(1);
    const valid = await buildMessage(
      { to: 'reader@example.net', subject: 'Hi', text: 'body' },
      {
        from: 'support@example.com',
      },
    );
    for (const change of [
      { subject: 'Bad\r\nInjected: yes' },
      { bcc: [{ email: 'bad@example.net,extra@example.org' }] },
      { headers: { Bcc: 'extra@example.org' } },
      { replyTo: { email: 'bad@example.net\r\nInjected: yes' } },
    ]) {
      const result = await consume(host, state.bindings, {
        id: 'tampered',
        queue: 'support-replies',
        name: 'mail:send',
        attempt: 1,
        data: { ...valid, ...change },
      });
      expect(result.error).toBeDefined();
      expect(result.explicitAcks).toEqual([]);
    }
    expect(state.sent).toEqual([]);
  });

  it('leaves provider failures unacknowledged and makes no exactly-once claim on redelivery', async () => {
    const state = fixture('retry');
    const host = worker();
    if (!host.email) throw new Error('Missing native email handler');
    const ctx = pool.createExecutionContext();
    await host.email(incoming(), state.bindings, ctx);
    await pool.waitOnExecutionContext(ctx);
    state.failWith(
      Object.assign(new Error('synthetic upstream detail'), { code: 'E_RATE_LIMIT_EXCEEDED' }),
    );
    const failed = await consume(host, state.bindings, state.queued[0]);
    expect(failed.error).toBeDefined();
    expect(failed.explicitAcks).toEqual([]);
    expect(state.sent).toHaveLength(0);
    state.failWith(undefined);
    expect((await consume(host, state.bindings, state.queued[0])).explicitAcks).toEqual([
      'reply-1',
    ]);
    expect((await consume(host, state.bindings, state.queued[0])).explicitAcks).toEqual([
      'reply-1',
    ]);
    expect(state.sent).toHaveLength(2);
  });

  it('submits a structured message to the real local send_email simulator without remote sending', async () => {
    const built = await buildMessage(
      {
        to: 'Reader <reader@example.net>',
        cc: 'copy@example.net',
        bcc: 'private@example.net',
        replyTo: 'help@example.com',
        subject: 'Local simulator',
        html: '<p>Hello</p>',
        text: 'Hello',
        headers: { 'X-Fixture': 'local' },
      },
      { from: 'Sender <support@example.com>' },
    );
    const result = await cloudflareEmailTransport({ binding: env.EMAIL }).deliver(built);
    expect(result.provider).toBe('cloudflare');
    expect(typeof result.id).toBe('string');
    expect(result.id?.length).toBeGreaterThan(0);
  });
});
