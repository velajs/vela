import { Container } from '../container/container';
import { defineModule } from '../module/define-module';
import { defineProvider } from '../container/types';
import { DiscoveryService } from '../discovery/discovery.service';
import { ENV } from '../env';
import { Inject, Injectable } from '../container/decorators';
import { referenceKey } from '../module/reference-key';
import type { ConfigurableModuleAsyncOptions } from '../module/configurable-module.types';
import type { DynamicModule } from '../registry/types';
import type { Token } from '../container/types';
import { inline } from './inline.driver';
import { QueueClient } from './queue.client';
import { QueueDispatchBinding } from './queue.binding';
import { QueueTransportEntrypoints } from './queue.entrypoints';
import { QueueRegistrationRecord, QueueRegistry, readQueueRegistration } from './queue.registry';
import { QUEUE_DRIVER, queueToken } from './queue.tokens';
import type { QueueDriver, QueueModuleOptions, QueueRegistration } from './queue.types';

/**
 * Stateful transports, driver factories and signed dispatch policies key by
 * reference: a helper that builds `target: () => ({ path })` per call yields
 * closures with one source but different captures. A different object is then
 * a second owner of QUEUE_DRIVER, which QueueDispatchBinding rejects whatever
 * the diagnostics policy, while re-importing the same object deduplicates. The
 * default inline, direct configuration keeps one key.
 */
function queueKey(options: QueueModuleOptions): string {
  const { driver, dispatch } = options;
  return referenceKey(
    driver ?? 'inline',
    dispatch === undefined || dispatch.kind === 'direct' ? 'direct' : dispatch,
  );
}

const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = defineModule<
  QueueModuleOptions,
  never,
  Record<never, never>
>({
  name: 'Queue',
  extras: {},
  // One driver per application, visible to every forFeature() module.
  transform: (definition) => ({ ...definition, global: true }),
  setup: ({ OPTIONS }) => ({
    providers: [
      QueueTransportEntrypoints,
      defineProvider(QueueRegistry, {
        useFactory: (discovery: DiscoveryService) => QueueRegistry.discover(discovery),
        inject: [DiscoveryService],
      }),
      defineProvider(QUEUE_DRIVER, {
        useFactory: (options: QueueModuleOptions, queues: QueueRegistry, container: Container) =>
          typeof options.driver === 'function'
            ? options.driver({
                env: container.has(ENV) ? container.resolve(ENV) : undefined,
                queues,
              })
            : (options.driver ?? inline()),
        inject: [OPTIONS, QueueRegistry, Container],
      }),
      defineProvider(QueueDispatchBinding, {
        useFactory: (
          container: Container,
          discovery: DiscoveryService,
          driver: QueueDriver,
          queues: QueueRegistry,
          options: QueueModuleOptions,
        ) => new QueueDispatchBinding(container, discovery, driver, queues, options.dispatch),
        inject: [Container, DiscoveryService, QUEUE_DRIVER, QueueRegistry, OPTIONS],
      }),
    ],
    exports: [QUEUE_DRIVER, QueueDispatchBinding, QueueRegistry],
  }),
});

/**
 * Explains a missing `QueueModule.forRoot()` before a client tries to resolve
 * the driver it provides. Instantiated with the client module, ahead of it.
 */
@Injectable()
class QueueModuleRequired {
  constructor(@Inject(Container) container: Container) {
    if (!container.has(QUEUE_DRIVER)) {
      throw new Error(
        'QueueModule.forFeature() needs QueueModule.forRoot() in the application: import ' +
          'QueueModule.forRoot({ driver }) once, in the root module.',
      );
    }
  }
}

/** Owns one queue's client, keyed by name, so every registration shares it. */
class QueueClientHost {}
/** Owns one registration record, keyed by the whole registration, like a defineModule instance. */
class QueueRegistrationHost {}
/** Groups the registrations of one `forFeature([a, b, ...])` call. */
class QueueRegistrationGroup {}

function registrationModule(input: QueueRegistration): DynamicModule {
  const registration = readQueueRegistration(input);
  const { name } = registration;
  const token = queueToken(name);
  const client: DynamicModule = {
    module: QueueClientHost,
    key: name,
    providers: [
      QueueModuleRequired,
      defineProvider(token, {
        // Injecting the binding binds the driver before the first add().
        useFactory: (driver: QueueDriver, _binding: QueueDispatchBinding) =>
          new QueueClient(name, driver),
        inject: [QUEUE_DRIVER, QueueDispatchBinding],
      }),
    ],
    exports: [token],
  };
  return {
    module: QueueRegistrationHost,
    key: JSON.stringify([name, registration.binding ?? null, registration.consumer ?? null]),
    imports: [client],
    providers: [
      defineProvider(QueueRegistrationRecord, {
        useValue: new QueueRegistrationRecord(registration),
      }),
    ],
    exports: [token],
  };
}

/**
 * First-party queue module, authored on vela's public API. Configure the driver
 * once, register each queue where it is used, and inject its client:
 *
 * ```ts
 * // root module
 * imports: [QueueModule.forRoot({ driver: cloudflareQueues() })]
 * // feature module
 * imports: [QueueModule.forFeature([{ name: 'email', binding: 'EMAIL_QUEUE' }])]
 * constructor(@InjectQueue('email') private readonly email: QueueClient) {}
 * ```
 *
 * `forRoot` is global: its driver, dispatcher and registry serve every
 * `forFeature` module. Processors are `@Processor(name)` providers in
 * ordinary modules. Transport configuration materializes at bootstrap,
 * including consumer-only applications, so native routes and registrations
 * are validated before events arrive. `forRootAsync` options are awaited
 * during application initialization.
 */
export class QueueModule extends ConfigurableModuleClass {
  /**
   * Configure the application's driver and dispatch policy (defaults:
   * `inline()`, direct). The driver and a signed policy compare by reference:
   * importing the same objects again deduplicates, and a different driver
   * instance or signed policy object fails bootstrap.
   */
  static override forRoot(options: QueueModuleOptions = {}): DynamicModule {
    return super.forRoot({ ...options, key: queueKey(options) });
  }

  /**
   * Resolve the options from a factory during application initialization. The
   * options object is the configuration: importing the same object again
   * deduplicates, while a different one, or a `forRoot` next to it, fails
   * bootstrap like two different `forRoot` configurations. An explicit `key`
   * does not change that, so two option objects sharing a key cannot merge
   * different dispatch policies.
   */
  static override forRootAsync<const Inject extends readonly Token[]>(
    options: ConfigurableModuleAsyncOptions<QueueModuleOptions, never, 'create', Inject>,
  ): DynamicModule {
    return super.forRootAsync({ ...options, key: referenceKey(options.key, options) });
  }

  /**
   * Register queues: provides each queue's `QueueClient` (`@InjectQueue(name)`)
   * to the importing module and declares the queue to the driver. Registering
   * a queue in several modules is fine; the same name must not name two
   * different bindings.
   */
  static forFeature(registrations: readonly QueueRegistration[]): DynamicModule {
    const modules = registrations.map(registrationModule);
    if (modules.length === 1) return modules[0]!;
    return {
      module: QueueRegistrationGroup,
      key: JSON.stringify(modules.map((module) => module.key)),
      imports: modules,
      exports: registrations.map(({ name }) => queueToken(name)),
    };
  }
}
export { MODULE_OPTIONS_TOKEN as QUEUE_MODULE_OPTIONS };
