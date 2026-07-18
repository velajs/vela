import { describe, it, expect, beforeEach } from 'vitest';
import { EmailMessage } from 'cloudflare:email';
import { Controller, Post, Module, Injectable, MetadataRegistry } from '@velajs/vela';
import { buildMessage, MailError, MailModule, MailService, OnInboundEmail } from '@velajs/mail';
import type { BuiltMessage, InboundEmail, MailInboundGate } from '@velajs/mail';
import { createCloudflareApp } from '../cloudflare-factory';
import { BindingRef } from '../binding-ref';
import { CloudflareEmailModule } from '../email/cloudflare-email.module';
import { createCloudflareEmailTransport } from '../email/cloudflare-email-transport';

beforeEach(() => {
  MetadataRegistry.clear();
});

// --- SendEmail double (structural, satisfies the workers-types binding) -------

interface SendCall {
  from: string;
  to: string;
}

// The binding's `send` is overloaded (raw EmailMessage OR a builder object); a
// double must accept both to be assignable to `SendEmail`. The transport only
// ever uses the raw-EmailMessage overload, so `instanceof EmailMessage` narrows
// the recorded call — no cast needed.
type SendArgument = EmailMessage | Parameters<SendEmail['send']>[0];

function createSendEmail(onSend: () => EmailSendResult | Promise<EmailSendResult>): {
  binding: SendEmail;
  calls: SendCall[];
} {
  const calls: SendCall[] = [];
  const binding: SendEmail = {
    send: (message: SendArgument): Promise<EmailSendResult> => {
      if (message instanceof EmailMessage) {
        calls.push({ from: message.from, to: message.to });
      }
      return Promise.resolve(onSend());
    },
  };
  return { binding, calls };
}

async function builtOf(
  to: string | string[],
  extra: { cc?: string[]; subject?: string } = {},
): Promise<BuiltMessage> {
  return buildMessage(
    {
      to,
      subject: extra.subject ?? 'Subject line',
      text: 'body text',
      ...(extra.cc === undefined ? {} : { cc: extra.cc }),
    },
    { from: 'no-reply@example.com' },
  );
}

// --- Outbound: createCloudflareEmailTransport ---------------------------------

describe('CloudflareEmailModule outbound transport', () => {
  it('constructs an EmailMessage per envelope recipient (fan-out) and joins ids', async () => {
    let counter = 0;
    const { binding, calls } = createSendEmail(() => ({ messageId: `id-${++counter}` }));
    const ref = new BindingRef<SendEmail>('SEND_EMAIL');
    ref._initialize(binding);

    const transport = createCloudflareEmailTransport(ref);
    const built = await builtOf(['a@example.com', 'b@example.com'], { cc: ['c@example.com'] });
    const result = await transport.deliver(built);

    // to + cc flatten to three envelope recipients → three single-recipient sends.
    expect(calls.map((c) => c.to)).toEqual(['a@example.com', 'b@example.com', 'c@example.com']);
    expect(calls.every((c) => c.from === 'no-reply@example.com')).toBe(true);
    expect(result).toEqual({ provider: 'cloudflare', id: 'id-1,id-2,id-3' });
  });

  it('does NOT read the binding ref at construction (lazy read at deliver time)', async () => {
    const ref = new BindingRef<SendEmail>('SEND_EMAIL');
    // ref is uninitialized: ref.value would throw. Construction must not touch it.
    const transport = createCloudflareEmailTransport(ref);
    expect(transport).toBeDefined();

    const { binding } = createSendEmail(() => ({ messageId: 'id-1' }));
    ref._initialize(binding);
    const result = await transport.deliver(await builtOf('a@example.com'));
    expect(result.id).toBe('id-1');
  });

  it('redacts provider errors: throws a fixed MailError, never the send() detail', async () => {
    const secret = 'SMTP 550 mailbox unavailable for internal-secret@corp.example';
    const { binding } = createSendEmail(() => {
      throw new Error(secret);
    });
    const ref = new BindingRef<SendEmail>('SEND_EMAIL');
    ref._initialize(binding);
    const transport = createCloudflareEmailTransport(ref);

    const error = await transport.deliver(await builtOf('a@example.com')).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(MailError);
    if (error instanceof MailError) {
      expect(error.message).toBe('@velajs/mail: email delivery failed');
      expect(error.message).not.toContain('internal-secret');
      expect(error.internal).toBe(true);
      expect(error.code).toBe('provider_error');
      // The raw cause is retained for server-side logging only.
      expect(error.cause).toBeInstanceOf(Error);
    }
  });
});

// --- Composition: CloudflareEmailModule provides MAIL_TRANSPORT globally -------

describe('CloudflareEmailModule + MailModule composition', () => {
  it('MailService.send delivers via the CF transport resolved from the global token', async () => {
    const { binding, calls } = createSendEmail(() => ({ messageId: 'wired-1' }));

    @Controller('/mail')
    class MailController {
      constructor(private readonly mail: MailService) {}

      @Post('/send')
      async send() {
        return this.mail.send({ to: 'rcpt@example.com', subject: 'Welcome', text: 'Hi there' });
      }
    }

    @Module({
      imports: [
        CloudflareEmailModule.forRoot(),
        MailModule.forRoot({ from: 'no-reply@example.com' }),
      ],
      controllers: [MailController],
    })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const res = await app
      .getHonoApp()
      .request('/mail/send', { method: 'POST' }, { SEND_EMAIL: binding });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ provider: 'cloudflare', id: 'wired-1' });
    expect(calls).toEqual([{ from: 'no-reply@example.com', to: 'rcpt@example.com' }]);

    await app.close();
  });

  it('honours a custom send_email binding name', async () => {
    const { binding, calls } = createSendEmail(() => ({ messageId: 'x' }));

    @Controller('/mail')
    class MailController {
      constructor(private readonly mail: MailService) {}

      @Post('/send')
      async send() {
        return this.mail.send({ to: 'rcpt@example.com', subject: 'Hi', text: 'Hi' });
      }
    }

    @Module({
      imports: [
        CloudflareEmailModule.forRoot({ binding: 'OUTBOUND_MAIL' }),
        MailModule.forRoot({ from: 'no-reply@example.com' }),
      ],
      controllers: [MailController],
    })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const res = await app
      .getHonoApp()
      .request('/mail/send', { method: 'POST' }, { OUTBOUND_MAIL: binding });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    await app.close();
  });
});

// --- Inbound: the email() host hook -------------------------------------------

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const body = new Response(bytes).body;
  if (body === null) throw new Error('expected a readable body stream');
  return body;
}

/**
 * A ForwardableEmailMessage double. `headers` is deliberately settable to a
 * misleading value so tests can prove neither it nor raw message headers are
 * promoted to a verified authentication verdict.
 */
function makeInboundMessage(opts: { raw: string; from: string; to: string; headers?: Headers }): {
  message: ForwardableEmailMessage;
  rejects: string[];
  forwards: string[];
} {
  const bytes = new TextEncoder().encode(opts.raw);
  const rejects: string[] = [];
  const forwards: string[] = [];
  const message: ForwardableEmailMessage = {
    from: opts.from,
    to: opts.to,
    rawSize: bytes.byteLength,
    headers: opts.headers ?? new Headers(),
    raw: streamOf(bytes),
    setReject: (reason: string): void => {
      rejects.push(reason);
    },
    forward: (rcptTo: string): Promise<EmailSendResult> => {
      forwards.push(rcptTo);
      return Promise.resolve({ messageId: 'fwd' });
    },
    reply: (): Promise<EmailSendResult> => Promise.resolve({ messageId: 'rpl' }),
  };
  return { message, rejects, forwards };
}

const CTX = { waitUntil: (): void => {} };

function rawEmail(headers: string[], body = 'hello world'): string {
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

/**
 * Cloudflare supplies the SMTP envelope out of band. These routing-only tests
 * deliberately accept one fixture envelope without treating raw message
 * headers as authentication; production applications should normally require
 * adapter-verified authentication verdicts as well.
 */
const TEST_ENVELOPE_GATE: MailInboundGate = {
  require: [],
  policy: (_authentication, email) =>
    email.envelope?.from === 'sender@partner.example' && email.envelope.to.endsWith('@my.example'),
};

describe('CloudflareApplication.email() host hook', () => {
  it('does not trust a raw DMARC pass without adapter verification', async () => {
    const received: string[] = [];

    @Injectable()
    class Inbox {
      @OnInboundEmail()
      async handle(email: InboundEmail): Promise<void> {
        received.push(email.subject ?? '');
      }
    }

    @Module({ providers: [Inbox] })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const { message, rejects } = makeInboundMessage({
      from: 'sender@partner.example',
      to: 'inbox@my.example',
      raw: rawEmail([
        'Authentication-Results: mx.my.example; dkim=pass; spf=pass; dmarc=pass',
        'From: sender@partner.example',
        'To: inbox@my.example',
        'Subject: Quarterly report',
      ]),
    });

    await app.email(message, {}, CTX);

    expect(received).toEqual([]);
    expect(rejects).toEqual(['message could not be processed']);
    await app.close();
  });

  it('rejects with a fixed generic reason and runs NO handler when the gate fails', async () => {
    const received: string[] = [];

    @Injectable()
    class Inbox {
      @OnInboundEmail()
      async handle(email: InboundEmail): Promise<void> {
        received.push(email.from);
      }
    }

    @Module({ providers: [Inbox] })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const { message, rejects } = makeInboundMessage({
      from: 'spoofer@evil.example',
      to: 'inbox@my.example',
      raw: rawEmail([
        'Authentication-Results: mx.my.example; dkim=fail; spf=fail; dmarc=fail',
        'From: spoofer@evil.example',
        'To: inbox@my.example',
        'Subject: Please wire funds',
      ]),
    });

    await app.email(message, {}, CTX);

    expect(received).toEqual([]);
    expect(rejects).toEqual(['message could not be processed']);
    await app.close();
  });

  it('fails closed when no Authentication-Results header is present', async () => {
    const received: string[] = [];

    @Injectable()
    class Inbox {
      @OnInboundEmail()
      async handle(): Promise<void> {
        received.push('ran');
      }
    }

    @Module({ providers: [Inbox] })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const { message, rejects } = makeInboundMessage({
      from: 'sender@partner.example',
      to: 'inbox@my.example',
      raw: rawEmail(['From: sender@partner.example', 'To: inbox@my.example', 'Subject: No auth']),
    });

    await app.email(message, {}, CTX);

    expect(received).toEqual([]);
    expect(rejects).toEqual(['message could not be processed']);
    await app.close();
  });

  it('trusts verdicts from neither the raw stream nor message.headers', async () => {
    const received: string[] = [];

    @Injectable()
    class Inbox {
      @OnInboundEmail()
      async handle(email: InboundEmail): Promise<void> {
        received.push(email.subject ?? '');
      }
    }

    @Module({ providers: [Inbox] })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    // Both sources are attacker-controlled message content. Even a topmost raw
    // dmarc=pass must not become an authenticated adapter verdict.
    const misleadingHeaders = new Headers({
      'Authentication-Results': 'mx.my.example; dmarc=fail',
    });
    const { message, rejects } = makeInboundMessage({
      from: 'sender@partner.example',
      to: 'inbox@my.example',
      headers: misleadingHeaders,
      raw: rawEmail([
        'Authentication-Results: mx.my.example; dmarc=pass',
        'Authentication-Results: attacker-injected; dmarc=fail',
        'From: sender@partner.example',
        'To: inbox@my.example',
        'Subject: Topmost wins',
      ]),
    });

    await app.email(message, {}, CTX);

    expect(received).toEqual([]);
    expect(rejects).toEqual(['message could not be processed']);
    await app.close();
  });

  it('drops (no setReject) when the gate passes but no handler matches', async () => {
    @Injectable()
    class Inbox {
      @OnInboundEmail({ match: (e) => e.envelope?.to.includes('support@') === true })
      async handle(): Promise<void> {
        throw new Error('should not run for a non-support recipient');
      }
    }

    @Module({
      imports: [
        MailModule.forRoot({
          from: 'no-reply@example.com',
          inbound: { gate: TEST_ENVELOPE_GATE },
        }),
      ],
      providers: [Inbox],
    })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const { message, rejects, forwards } = makeInboundMessage({
      from: 'sender@partner.example',
      to: 'sales@my.example',
      raw: rawEmail([
        'Authentication-Results: mx.my.example; dmarc=pass',
        'From: sender@partner.example',
        // Raw To is attacker-controlled and intentionally conflicts with the
        // platform envelope used by the match predicate.
        'To: support@my.example',
        'Subject: Unrouted',
      ]),
    });

    await app.email(message, {}, CTX);

    // Gate passed, but the match predicate excluded the only handler → drop.
    expect(rejects).toEqual([]);
    expect(forwards).toEqual([]);
    await app.close();
  });

  it('routes to the matching handler by recipient via @OnInboundEmail({ match })', async () => {
    const support: string[] = [];
    const billing: string[] = [];

    @Injectable()
    class SupportInbox {
      @OnInboundEmail({ match: (e) => e.envelope?.to.includes('support@') === true })
      async handle(email: InboundEmail): Promise<void> {
        support.push(email.subject ?? '');
      }
    }

    @Injectable()
    class BillingInbox {
      @OnInboundEmail({ match: (e) => e.envelope?.to.includes('billing@') === true })
      async handle(email: InboundEmail): Promise<void> {
        billing.push(email.subject ?? '');
      }
    }

    @Module({
      imports: [
        MailModule.forRoot({
          from: 'no-reply@example.com',
          inbound: { gate: TEST_ENVELOPE_GATE },
        }),
      ],
      providers: [SupportInbox, BillingInbox],
    })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const { message } = makeInboundMessage({
      from: 'sender@partner.example',
      to: 'support@my.example',
      raw: rawEmail([
        'Authentication-Results: mx.my.example; dmarc=pass',
        'From: sender@partner.example',
        // Routing follows the trusted envelope, never this spoofable header.
        'To: billing@my.example',
        'Subject: Help please',
      ]),
    });

    await app.email(message, {}, CTX);

    expect(support).toEqual(['Help please']);
    expect(billing).toEqual([]);
    await app.close();
  });
});
