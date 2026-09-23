import { InjectionToken } from '@velajs/vela';
import { MailModule, type InboundEmail, type MailTransport } from '@velajs/mail';
import { createMailCatcher } from '@velajs/mail/transports/catcher';

const Transport = new InjectionToken<MailTransport>('mail-transport');
MailModule.forRootAsync({
  inject: [Transport],
  useFactory: (transport) => ({
    from: 'sender@example.com',
    transport,
  }),
});
MailModule.forRootAsync({
  useFactory: () => ({
    from: 'sender@example.com',
    transport: createMailCatcher(),
  }),
});
// @ts-expect-error a factory with parameters must declare its inject tokens
MailModule.forRootAsync({ useFactory: (transport: MailTransport) => ({ from: 'sender@example.com', transport }) });
function agentContract(email: InboundEmail): Uint8Array {
  const source: 'adapter' | 'authserv-id' | 'none' = email.authenticationSource;
  const recipients: string[] = email.to;
  const subject: string | undefined = email.subject;
  void [source, recipients, subject];
  return email.raw();
}
void agentContract;
