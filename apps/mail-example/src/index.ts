import { Inject, Injectable, Module, Scope, VelaFactory } from '@velajs/vela';
import { inline, QueueModule } from '@velajs/vela/queue';
import {
  MailModule,
  MailService,
  OnInboundEmail,
  dispatchInboundEmail,
  parseInboundEmail,
  type InboundEmail,
} from '@velajs/mail';
import { createMailCatcher } from '@velajs/mail/transports/catcher';
import { assertCount, assertSent } from '@velajs/mail/testing';

const catcher = createMailCatcher();
const driver = inline({ mode: 'manual' });
const mail = MailModule.forRoot({
  from: 'support@example.com',
  transport: catcher,
  queue: { name: 'support-replies' },
});

@Injectable({ scope: Scope.REQUEST })
class SupportInbox {
  constructor(@Inject(MailService) private readonly mailer: MailService) {}

  @OnInboundEmail({ match: (email) => email.envelope?.to === 'support@example.com' })
  async receive(email: InboundEmail): Promise<void> {
    // A real application resolves a verified account/tenant before authorizing
    // any work. Neither the visible From header nor DMARC alone proves that.
    console.log(`Received: ${email.subject ?? '(no subject)'}`);
    await this.mailer.queue({
      to: 'demo-user@example.com',
      subject: 'Support request received',
      text: 'We received your request.',
    });
  }
}

@Module({ imports: [mail], providers: [SupportInbox] })
class SupportModule {}
@Module({ imports: [QueueModule.forRoot({ queues: ['support-replies'], driver }), SupportModule] })
class AppModule {}

const app = await VelaFactory.create(AppModule);
try {
  // Local fixture only: a production adapter must obtain these verdicts from
  // the trusted receiving service. Do not attest arbitrary HTTP request data.
  const incoming = parseInboundEmail(
    'From: demo-user@example.com\r\nTo: support@example.com\r\nSubject: Account help\r\n\r\nHello',
    {
      envelope: { from: 'demo-user@example.com', to: 'support@example.com' },
      verifiedAuthentication: { dkim: 'pass', spf: 'pass', dmarc: 'pass' },
    },
  );
  const result = await dispatchInboundEmail(app.getContainer(), app.entrypoints, incoming);
  if (result.gated || result.handled !== 1)
    throw new Error('Expected one accepted support handler');
  assertCount(catcher, 0);
  await driver.flush();
  assertCount(catcher, 1);
  console.log(assertSent(catcher, { to: 'demo-user@example.com' }).subject);
} finally {
  await app.dispose();
}
