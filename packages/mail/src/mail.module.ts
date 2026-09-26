import {
  type ConfigurableModuleAsyncOptions,
  type DynamicModule,
  defineModule,
  defineProvider,
  type ModuleFactoryOptions,
  type ProviderDefinition,
  type Token,
  type Type,
} from '@velajs/vela';
import { Container } from '@velajs/vela/module-kit';
import { QueueModule } from '@velajs/vela/queue';
import type { MailInboundGate } from './inbound/gate';
import {
  assertUniqueMailQueues,
  MAIL_QUEUE_REGISTRATION,
  MailInboundGateRegistration,
} from './mail.configuration';
import { type MailLimits, resolveMailLimits } from './limits';
import { MailService } from './mail.service';
import { createMailSendProcessor } from './mail.processor';
import { MAIL_OPTIONS, MAIL_QUEUE, type ResolvedMailOptions } from './mail.tokens';
import type { AddressInput, MailTransport, RenderSeam } from './types';

/**
 * The queue `MailService.queue()` sends through. The mailer registers it with
 * `QueueModule.forFeature([{ name, binding, consumer }])`, so the application
 * only imports `QueueModule.forRoot({ driver })`.
 */
export interface MailQueueOptions {
  /** Logical queue name. Defaults to `'mail'`. */
  name?: string;
  /** Producer binding the driver sends through, such as a Wrangler `queues.producers[].binding`. */
  binding?: string;
  /** Physical queue to pin the queue to, as `QueueModule.forFeature([{ consumer }])` does. */
  consumer?: string;
}

export interface MailModuleOptions {
  /** Default `from` for messages that omit their own. */
  from: AddressInput;
  /**
   * A transport to use directly. When omitted, `MailService` resolves the
   * {@link MAIL_TRANSPORT} token an application-authored transport module provides.
   */
  transport?: MailTransport;
  /** Optional template renderer, required only for messages that carry a `template`. */
  render?: RenderSeam;
  /**
   * Enable the queue-backed send path. Structural: pass it alongside the
   * factory for `registerAsync`. The mailer registers the queue (`name`
   * defaults to `'mail'`) and its consumer; the application imports
   * `QueueModule.forRoot({ driver })` once.
   */
  queue?: MailQueueOptions;
  /**
   * Application-wide inbound gate, resolved through DI and discovered by the
   * inbound dispatcher. Absent uses the fail-closed DMARC default.
   */
  inbound?: { gate?: MailInboundGate };
  /** Outbound and queue-boundary resource ceilings. */
  limits?: Partial<MailLimits>;
}

/** The options `registerAsync` takes alongside its factory: they shape the module graph. */
export type MailStructuralOption = 'queue';

/** Options an async factory resolves; structural contributions stay at the call site. */
export type MailModuleFactoryOptions = ModuleFactoryOptions<
  MailModuleOptions,
  MailStructuralOption
>;

/**
 * Deferred MailModule registration with tuple-inferred injected dependencies.
 * A factory without parameters may omit `inject`.
 */
export type MailModuleAsyncOptions<Inject extends readonly Token[] = readonly Token[]> =
  ConfigurableModuleAsyncOptions<MailModuleOptions, MailStructuralOption, 'create', Inject> & {
    isGlobal?: boolean;
  };

/** Lower the (possibly async-resolved) options bag to what the runtime reads. */
function resolveMailOptions(o: MailModuleOptions): ResolvedMailOptions {
  const out: ResolvedMailOptions = { from: o.from, limits: resolveMailLimits(o.limits) };
  if (o.render !== undefined) out.render = o.render;
  if (o.transport !== undefined) out.transport = o.transport;
  if (o.queue !== undefined) {
    out.queueName = o.queue.name ?? MAIL_QUEUE;
    if (out.queueName.length === 0 || out.queueName !== out.queueName.trim()) {
      throw new Error('@velajs/mail: queue name must be a non-empty string');
    }
  }
  return out;
}

const { ConfigurableModuleClass } = defineModule<
  MailModuleOptions,
  MailStructuralOption,
  { isGlobal?: boolean },
  'register'
>({
  name: 'Mail',
  methodName: 'register',
  identity: 'registration',
  structural: ['queue'],
  setup: ({ OPTIONS, options }) => {
    const providers: Array<Type | ProviderDefinition> = [
      defineProvider(MAIL_OPTIONS, {
        useFactory: (o, container) => {
          assertUniqueMailQueues(container);
          return resolveMailOptions(o);
        },
        inject: [OPTIONS, Container],
      }),
      defineProvider(MailInboundGateRegistration, {
        inject: [OPTIONS],
        useFactory: (resolved) => new MailInboundGateRegistration(resolved.inbound?.gate),
      }),
      MailService,
    ];

    const imports: DynamicModule[] = [];
    // Every registration gets its own class token so the core queue dispatcher
    // resolves this registration's MAIL_OPTIONS, including the default queue.
    if (options.queue !== undefined) {
      const { name: queueName = MAIL_QUEUE, binding, consumer } = options.queue;
      providers.push(
        defineProvider(MAIL_QUEUE_REGISTRATION, { useValue: queueName }),
        createMailSendProcessor(queueName),
      );
      imports.push(
        QueueModule.forFeature([
          {
            name: queueName,
            ...(binding === undefined ? {} : { binding }),
            ...(consumer === undefined ? {} : { consumer }),
          },
        ]),
      );
    }

    const moduleExports: Token[] = [MailService, MAIL_OPTIONS];
    return { providers, exports: moduleExports, imports };
  },
});

/**
 * The Vela mail module. Provides `MailService` (the injectable producer) and,
 * when `queue` is set, registers that queue with `QueueModule.forFeature`
 * and its `mail:send` consumer so the vela queue dispatcher picks it up.
 * Compose a transport by passing `transport` directly or by importing a
 * transport module (which provides {@link MAIL_TRANSPORT}) before this one.
 *
 * `queue` is structural; `registerAsync` takes it beside its factory. The
 * factory returns outbound settings and the inbound gate. Each call owns a
 * mailer; reuse the returned module to share it. Explicit keys remain available
 * and reject conflicting options. Distinct mailers need distinct queue names.
 */
export class MailModule extends ConfigurableModuleClass {}
