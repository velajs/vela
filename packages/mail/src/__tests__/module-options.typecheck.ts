import { InjectionToken } from '@velajs/vela';
import { MailModule } from '../mail.module';
import type { MailTransport } from '../types';

const Config = new InjectionToken<{ from: string; transport: MailTransport }>('mail-config');

MailModule.forRootAsync({
  inject: [Config],
  useFactory: (config) => ({ from: config.from, transport: config.transport }),
});
MailModule.forRootAsync({ inject: [], useFactory: () => ({ from: 'a@example.com' }) });

// @ts-expect-error factories must declare even an empty dependency tuple
MailModule.forRootAsync({ useFactory: () => ({ from: 'a@example.com' }) });
MailModule.forRootAsync({
  inject: ['untyped-config'],
  // @ts-expect-error a raw string token cannot promise a typed configuration
  useFactory: (config: { from: string }) => ({ from: config.from }),
});
MailModule.forRootAsync({
  inject: [Config],
  // @ts-expect-error the factory must match its actual injected token
  useFactory: (config: number) => ({ from: String(config) }),
});

MailModule.forRoot({
  from: 'a@example.com',
  queue: { name: 'mail', binding: 'MAIL_QUEUE', consumer: 'mail-production' },
});
MailModule.forRootAsync({
  inject: [],
  useFactory: () => ({ from: 'a@example.com' }),
  queue: { binding: 'MAIL_QUEUE' },
});
// @ts-expect-error a queue binding is a binding name
MailModule.forRoot({ from: 'a@example.com', queue: { binding: 1 } });
