import {
  Container,
  type DynamicModule,
  defineModule,
  type FactoryInject,
  type InferTokens,
  type ModuleImport,
  defineProvider,
  type ProviderDefinition,
  stableHash,
  type Token,
  type Type,
} from '@velajs/vela';
import { QueueModule } from '@velajs/vela/queue';
import { snapshotInboundGate, type MailInboundGate } from './inbound/gate';
import { assertUniqueMailQueues, MAIL_QUEUE_REGISTRATION } from './mail.configuration';
import { type MailLimits, resolveMailLimits } from './limits';
import { MailService } from './mail.service';
import { createMailSendProcessor } from './mail.processor';
import {
  MAIL_INBOUND_GATE,
  MAIL_OPTIONS,
  MAIL_QUEUE,
  type ResolvedMailOptions,
} from './mail.tokens';
import type { AddressInput, MailTransport, RenderSeam } from './types';

/**
 * The queue `MailService.queue()` sends through. The mailer registers it with
 * `QueueModule.registerQueue({ name, binding, consumer })`, so the application
 * only imports `QueueModule.forRoot({ driver })`.
 */
export interface MailQueueOptions {
  /** Logical queue name. Defaults to `'mail'`. */
  name?: string;
  /** Producer binding the driver sends through, such as a Wrangler `queues.producers[].binding`. */
  binding?: string;
  /** Physical queue to pin the queue to, as `QueueModule.registerQueue({ consumer })` does. */
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
   * Enable the queue-backed send path. STRUCTURAL — pass it alongside the
   * factory for `forRootAsync`. The mailer registers the queue (`name`
   * defaults to `'mail'`) and its consumer; the application imports
   * `QueueModule.forRoot({ driver })` once.
   */
  queue?: MailQueueOptions;
  /**
   * App-level inbound gate. When a custom `gate` is given it is globalized (the
   * `SCHEDULE_DISPATCH` pattern) so the cross-module inbound dispatcher reads
   * it; absent ⇒ the dispatcher's fail-closed default (`{ require: ['dmarc'] }`).
   */
  inbound?: { gate?: MailInboundGate };
  /** Outbound and queue-boundary resource ceilings. */
  limits?: Partial<MailLimits>;
}

/** Options an async factory resolves; structural contributions stay at the call site. */
export type MailModuleFactoryOptions = Omit<MailModuleOptions, 'queue' | 'inbound'>;

/**
 * Deferred MailModule registration with tuple-inferred injected dependencies.
 * A factory without parameters may omit `inject`.
 */
export type MailModuleAsyncOptions<Inject extends readonly Token[] = readonly Token[]> = {
  imports?: ModuleImport[];
  useFactory: (
    ...deps: InferTokens<Inject>
  ) => MailModuleFactoryOptions | Promise<MailModuleFactoryOptions>;
  /** Structural: required here (not only in the factory result) to register the queue consumer. */
  queue?: MailModuleOptions['queue'];
  /** Structural: required here (not only in the factory result) to register the global gate host. */
  inbound?: MailModuleOptions['inbound'];
  isGlobal?: boolean;
  /** Optional label; configuration reference identity remains part of the key. */
  key?: string;
} & FactoryInject<Inject>;

const referenceIds = new WeakMap<object, number>();
const symbolReferenceIds = new Map<symbol, number>();
let nextReferenceId = 1;

function referenceId(reference: unknown): string {
  if (reference === undefined) return 'none';
  if ((typeof reference === 'object' && reference !== null) || typeof reference === 'function') {
    const objectReference = reference as object;
    const existing = referenceIds.get(objectReference);
    if (existing !== undefined) return `object:${existing}`;
    const id = nextReferenceId++;
    referenceIds.set(objectReference, id);
    return `object:${id}`;
  }
  if (typeof reference === 'symbol') {
    const existing = symbolReferenceIds.get(reference);
    if (existing !== undefined) return `symbol:${existing}`;
    const id = nextReferenceId++;
    symbolReferenceIds.set(reference, id);
    return `symbol:${id}`;
  }
  return `${typeof reference}:${String(reference)}`;
}

interface MailRegistrationIdentity {
  readonly kind: 'options' | 'factory';
  readonly shape: string;
  readonly references: string;
}

function registrationKey(identity: MailRegistrationIdentity, explicitKey?: string): string {
  if (
    explicitKey !== undefined &&
    (explicitKey.length === 0 || explicitKey !== explicitKey.trim())
  ) {
    throw new Error('@velajs/mail: an explicit module key must be a non-empty string');
  }
  // A key labels a registration, never grants it permission to reuse another
  // configuration's state. No process-wide claims: separate apps are independent.
  return `mail:${JSON.stringify(explicitKey)}:${identity.shape}:${identity.kind}:${identity.references}`;
}

/** Stable string identity for a `from` input (used only in the dedup key). */
function fromKey(from: AddressInput | undefined): string {
  if (from === undefined) return '';
  if (typeof from === 'string') return from;
  return from.name === undefined ? from.email : `${from.name} <${from.email}>`;
}

type StructuralMailOptions = Partial<MailModuleOptions> & { isGlobal?: boolean };

function structuralKeyPart(options: StructuralMailOptions): Record<string, unknown> {
  const gate = options.inbound?.gate;
  return {
    from: fromKey(options.from),
    queue:
      options.queue === undefined
        ? undefined
        : {
            name: options.queue.name ?? MAIL_QUEUE,
            binding: options.queue.binding ?? null,
            consumer: options.queue.consumer ?? null,
          },
    gate: gate === undefined ? 'default' : { require: gate.require ?? null },
    limits: resolveMailLimits(options.limits),
    isGlobal: options.isGlobal ?? false,
  };
}

function referenceSignature(options: StructuralMailOptions, factory?: object): string {
  const gate = options.inbound?.gate;
  return [
    `transport=${referenceId(options.transport)}`,
    `render=${referenceId(options.render)}`,
    `gate=${referenceId(gate)}`,
    `policy=${referenceId(gate?.policy)}`,
    `factory=${referenceId(factory)}`,
  ].join(':');
}

function wiringReferenceSignature<Inject extends readonly Token[]>(
  options: MailModuleAsyncOptions<Inject>,
): string {
  return [
    `inject=${JSON.stringify((options.inject ?? []).map(referenceId))}`,
    `imports=${JSON.stringify((options.imports ?? []).map(referenceId))}`,
  ].join(':');
}

function syncIdentity(options: StructuralMailOptions): MailRegistrationIdentity {
  return {
    kind: 'options',
    shape: stableHash(structuralKeyPart(options)),
    references: referenceSignature(options),
  };
}

function asyncIdentity<Inject extends readonly Token[]>(
  options: MailModuleAsyncOptions<Inject>,
): MailRegistrationIdentity {
  const structural = options as MailModuleAsyncOptions<Inject> & StructuralMailOptions;
  return {
    kind: 'factory',
    shape: stableHash(structuralKeyPart(structural)),
    references: `${referenceSignature(structural, options.useFactory)}:${wiringReferenceSignature(options)}`,
  };
}

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

/**
 * Dedicated global host for a custom inbound gate — mirrors
 * `ScheduleDispatchHost` so only the gate token globalizes (a dynamic module's
 * `global: true` globalizes ALL its exports). Undecorated on purpose: the loader
 * auto-registers empty metadata for a class used only as a dynamic module's
 * `module`.
 */
class MailInboundGateHost {}

function gateHost(gate: MailInboundGate): DynamicModule {
  return {
    module: MailInboundGateHost,
    key:
      `mail-gate:${stableHash({ require: gate.require ?? null })}` +
      `:gate=${referenceId(gate)}:policy=${referenceId(gate.policy)}`,
    providers: [defineProvider(MAIL_INBOUND_GATE, { useValue: snapshotInboundGate(gate) })],
    exports: [MAIL_INBOUND_GATE],
    global: true,
  };
}

const mailModuleHost = defineModule<MailModuleOptions>({
  name: 'Mail',
  // Public entry points always provide an identity-aware key. This fallback
  // keeps direct host use fail-safe if the wrapper is refactored later.
  key: (options) => registrationKey(syncIdentity(options)),
  setup: ({ OPTIONS, options }) => {
    const providers: Array<Type | ProviderDefinition> = [
      defineProvider(MAIL_OPTIONS, {
        useFactory: (o, container) => {
          assertUniqueMailQueues(container);
          return resolveMailOptions(o);
        },
        inject: [OPTIONS, Container],
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
        QueueModule.registerQueue({
          name: queueName,
          ...(binding === undefined ? {} : { binding }),
          ...(consumer === undefined ? {} : { consumer }),
        }),
      );
    }

    const customGate = options.inbound?.gate;
    if (customGate !== undefined) imports.push(gateHost(customGate));

    const moduleExports: Token[] = [MailService, MAIL_OPTIONS];
    return { providers, exports: moduleExports, imports };
  },
});

/**
 * The Vela mail module. Provides `MailService` (the injectable producer) and,
 * when `queue` is set, registers that queue with `QueueModule.registerQueue`
 * and its `mail:send` consumer so the vela queue dispatcher picks it up. Compose a transport by passing `transport` directly or
 * by importing a transport module (which provides {@link MAIL_TRANSPORT}) before
 * this one.
 */
export class MailModule {
  /** Synchronous registration keyed by every stateful transport/render/gate reference. */
  static forRoot(options: MailModuleOptions & { isGlobal?: boolean; key?: string }): DynamicModule {
    const { key: explicitKey, ...mailOptions } = options;
    const key = registrationKey(syncIdentity(mailOptions), explicitKey);
    return {
      ...mailModuleHost.ConfigurableModuleClass.forRoot({ ...mailOptions, key }),
      module: MailModule,
    };
  }

  /** Deferred registration keyed by factory identity, including same-source closures. */
  static forRootAsync<const Inject extends readonly Token[] = readonly Token[]>(
    options: MailModuleAsyncOptions<Inject>,
  ): DynamicModule {
    const { useFactory } = options;
    const key = registrationKey(asyncIdentity(options), options.key);
    return {
      ...mailModuleHost.ConfigurableModuleClass.forRootAsync<Inject>({
        ...options,
        useFactory: async (...deps: InferTokens<Inject>) => {
          const resolved = await useFactory(...deps);
          if ('queue' in resolved || 'inbound' in resolved) {
            throw new Error(
              '@velajs/mail: queue and inbound must be structural options, outside useFactory',
            );
          }
          return resolved;
        },
        key,
      }),
      module: MailModule,
    };
  }
}
