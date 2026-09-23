import {
  Container,
  defineModule,
  defineProvider,
  DiscoveryService,
  ENV,
  Inject,
  Injectable,
  stableHash,
} from '../index';
import type {
  ConfigurableModuleAsyncOptions,
  DynamicModule,
  ModuleRegistrationOptions,
  Token,
} from '../index';
import { inline } from './inline.driver';
import { QueueClient } from './queue.client';
import { QueueDispatchBinding } from './queue.binding';
import { QueueTransportEntrypoints } from './queue.entrypoints';
import { attachQueueRegistration, QueueRegistry, readQueueRegistration } from './queue.registry';
import { QUEUE_DRIVER, queueToken } from './queue.tokens';
import type { QueueDriver, QueueModuleOptions, QueueRegistration } from './queue.types';

// Stateful transport objects, factories and signed dispatch policies must not
// dedup by their kind or source: a helper that builds `target: () => ({ path })`
// per call yields closures with one source but different captures. Each such
// object keys by reference, so a different one becomes a second owner of
// QUEUE_DRIVER, which QueueDispatchBinding rejects, while re-importing the same
// object deduplicates. Default inline, direct configuration keeps a stable key.
const referenceIds = new WeakMap<object, number>();
let nextReferenceId = 0;
function referenceId(value: object): number {
  const existing = referenceIds.get(value);
  if (existing !== undefined) return existing;
  const id = ++nextReferenceId;
  referenceIds.set(value, id);
  return id;
}

function driverIdentity(driver: QueueModuleOptions['driver']): string | number {
  return driver === undefined ? 'default-inline' : referenceId(driver);
}

function dispatchIdentity(dispatch: QueueModuleOptions['dispatch']): string | number {
  return dispatch === undefined || dispatch.kind === 'direct' ? 'direct' : referenceId(dispatch);
}

const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = defineModule<
  QueueModuleOptions,
  Record<never, never>
>({
  name: 'Queue',
  key: (o) =>
    stableHash({
      driver: driverIdentity(o.driver),
      dispatch: dispatchIdentity(o.dispatch),
    }),
  extras: {},
  // One driver per application, visible to every registerQueue() module.
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
        'QueueModule.registerQueue() needs QueueModule.forRoot() in the application: import ' +
          'QueueModule.forRoot({ driver }) once, in the root module.',
      );
    }
  }
}

/** Owns one queue's client, keyed by name, so every registration shares it. */
class QueueClientHost {}
/** Owns one registration record, keyed by the whole registration. */
class QueueRegistrationHost {}
/** Groups the registrations of one `registerQueue(a, b, ...)` call. */
class QueueRegistrationGroup {}

function registrationModule(input: QueueRegistration): DynamicModule {
  const registration = readQueueRegistration(input);
  const { name } = registration;
  const token = queueToken(name);
  class QueueRegistrationRecord {}
  Object.defineProperty(QueueRegistrationRecord, 'name', {
    value: `QueueRegistration(${name})`,
  });
  Injectable()(QueueRegistrationRecord);
  attachQueueRegistration(QueueRegistrationRecord, registration);
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
    providers: [QueueRegistrationRecord],
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
 * imports: [QueueModule.registerQueue({ name: 'email', binding: 'EMAIL_QUEUE' })]
 * constructor(@InjectQueue('email') private readonly email: QueueClient) {}
 * ```
 *
 * `forRoot` is global: its driver, dispatcher and registry serve every
 * `registerQueue` module. Processors are `@Processor(name)` providers in
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
    return super.forRoot(options);
  }

  /**
   * Resolve the options from a factory during application initialization. The
   * options object is the configuration: importing the same object again
   * deduplicates, while a different one, or a `forRoot` next to it, fails
   * bootstrap like two different `forRoot` configurations.
   */
  static override forRootAsync<const Inject extends readonly Token[]>(
    options: ConfigurableModuleAsyncOptions<QueueModuleOptions, 'create', Inject> &
      ModuleRegistrationOptions,
  ): DynamicModule {
    return super.forRootAsync({ ...options, key: options.key ?? `async:${referenceId(options)}` });
  }

  /**
   * Register queues: provides each queue's `QueueClient` (`@InjectQueue(name)`)
   * to the importing module and declares the queue to the driver. Registering
   * a queue in several modules is fine; the same name must not name two
   * different bindings.
   */
  static registerQueue(
    registration: QueueRegistration,
    ...more: QueueRegistration[]
  ): DynamicModule {
    const registrations = [registration, ...more];
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
