import { ENV, Inject, Injectable, Module, Scope, type VelaEnv } from '@velajs/vela';
import { QueueModule } from '@velajs/vela/queue';
import { createCloudflareWorker } from '@velajs/cloudflare';
import { OnEmail } from '@velajs/cloudflare/email';
import { cloudflareQueues } from '@velajs/cloudflare/queues';
import { MailModule, MailService, readInboundEmail } from '@velajs/mail';
import { cloudflareEmailTransport } from '@velajs/mail/transports/cloudflare';

@Injectable({ scope: Scope.REQUEST })
class SupportInbox {
  constructor(
    @Inject(MailService) private readonly mail: MailService,
    @Inject(ENV) private readonly env: VelaEnv,
  ) {}

  @OnEmail({ to: 'support@example.com' })
  async receive(message: ForwardableEmailMessage): Promise<void> {
    const incoming = await readInboundEmail(message);
    // This demo responds only to an operator-configured address. Real applications
    // must authorize the recipient; native routing does not authenticate an app user.
    // Do not reflect arbitrary From/Reply-To or attest raw Authentication-Results.
    await this.mail.queue({
      to: this.env.REPLY_RECIPIENT,
      replyTo: this.env.MAIL_FROM,
      subject: 'Support request received',
      text: `We received your request: ${incoming.subject ?? '(no subject)'}`,
      headers: { 'Auto-Submitted': 'auto-replied' },
    });
  }
}

@Module({
  imports: [
    QueueModule.forRoot({ driver: cloudflareQueues() }),
    MailModule.forRootAsync({
      inject: [ENV],
      useFactory: (env) => ({
        from: env.MAIL_FROM,
        transport: cloudflareEmailTransport({ binding: env.EMAIL }),
        limits: { maxRecipients: 50 },
      }),
      queue: { name: 'support-replies', binding: 'MAIL_QUEUE', consumer: 'mail-example-replies' },
    }),
  ],
  providers: [SupportInbox],
})
export class AppModule {}

// OnEmail installs email(); the existing queue host dispatches MailModule's processor.
export default createCloudflareWorker(AppModule);
