import { InjectionToken } from '@velajs/vela';
import { MailModule } from '../mail.module';
import type { MailTransport } from '../types';

const Config = new InjectionToken<{ from: string; transport: MailTransport }>('mail-config');

MailModule.registerAsync({
  inject: [Config],
  useFactory: (config) => ({ from: config.from, transport: config.transport }),
});
MailModule.registerAsync({ inject: [], useFactory: () => ({ from: 'a@example.com' }) });
MailModule.registerAsync({ useFactory: () => ({ from: 'a@example.com' }) });
MailModule.registerAsync({
  useFactory: () => ({ from: 'a@example.com', inbound: { gate: { require: ['spf'] } } }),
});
MailModule.registerAsync({
  // @ts-expect-error The inbound gate resolves through the options factory.
  inbound: { gate: { require: ['spf'] } },
  useFactory: () => ({ from: 'a@example.com' }),
});

// @ts-expect-error a factory with parameters names the tokens that supply them
MailModule.registerAsync({ useFactory: (config: { from: string }) => ({ from: config.from }) });
// @ts-expect-error a caller-only dependency tuple cannot supply runtime tokens
MailModule.registerAsync<readonly [typeof Config]>({
  useFactory: () => ({ from: 'a@example.com' }),
});
MailModule.registerAsync({
  inject: ['untyped-config'],
  // @ts-expect-error a raw string token cannot promise a typed configuration
  useFactory: (config: { from: string }) => ({ from: config.from }),
});
MailModule.registerAsync({
  inject: [Config],
  // @ts-expect-error the factory must match its actual injected token
  useFactory: (config: number) => ({ from: String(config) }),
});

MailModule.register({
  from: 'a@example.com',
  queue: { name: 'mail', binding: 'MAIL_QUEUE', consumer: 'mail-production' },
});
MailModule.registerAsync({
  useFactory: () => ({ from: 'a@example.com' }),
  queue: { binding: 'MAIL_QUEUE' },
});
// @ts-expect-error a queue binding is a binding name
MailModule.register({ from: 'a@example.com', queue: { binding: 1 } });
