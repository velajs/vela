import { InjectionToken } from '@velajs/vela';
import { MailModule, type InboundEmail, type MailTransport } from '@velajs/mail';
import { createMailCatcher } from '@velajs/mail/transports/catcher';

const Transport = new InjectionToken<MailTransport>('mail-transport');
MailModule.registerAsync({
  inject: [Transport],
  useFactory: (transport) => ({
    from: 'sender@example.com',
    transport,
  }),
});
MailModule.registerAsync({
  useFactory: () => ({
    from: 'sender@example.com',
    transport: createMailCatcher(),
  }),
});
MailModule.registerAsync({
  // @ts-expect-error a factory with parameters must declare its inject tokens
  useFactory: (transport: MailTransport) => ({ from: 'sender@example.com', transport }),
});
function agentContract(email: InboundEmail): Uint8Array {
  const source: 'adapter' | 'authserv-id' | 'none' = email.authenticationSource;
  const recipients: string[] = email.to;
  const subject: string | undefined = email.subject;
  void [source, recipients, subject];
  return email.raw();
}
void agentContract;
