import { Container, defineModule, defineProvider, DiscoveryService, stableHash } from '../index';
import type { ProviderDefinition } from '../index';
import { inline } from './inline.driver';
import { QueueClient } from './queue.client';
import { QueueDispatchBinding } from './queue.binding';
import { QueueTransportEntrypoints } from './queue.entrypoints';
import { QUEUE_DRIVER, queueToken } from './queue.tokens';
import type { QueueDriver, QueueModuleOptions } from './queue.types';

// Stateful transport objects and factories must not dedup by their kind/source.
// Default inline configuration still has a stable structural key.
const driverIds = new WeakMap<object, number>();
let nextDriverId = 0;
function driverIdentity(driver: QueueModuleOptions['driver']): string | number {
  if (driver === undefined) return 'default-inline';
  const existing = driverIds.get(driver);
  if (existing !== undefined) return existing;
  const id = ++nextDriverId;
  driverIds.set(driver, id);
  return id;
}

/**
 * First-party queue module — authored 100% on vela's public API (the
 * roadmap's "openness proof"). Producers inject a per-queue `QueueClient`
 * via `queueToken(name)`; consumers are `@Processor`/`@Process` classes in
 * ordinary user modules; platforms deliver through `dispatchQueueJob` or the
 * in-core `inline()` driver.
 *
 * ```ts
 * imports: [QueueModule.forRoot({ queues: ['email'] })]
 * ```
 *
 * Transport configuration materializes at bootstrap, including consumer-only
 * modules, so native routes and ownership are validated before accepting events.
 * Job providers still retain their declared invocation/lazy lifetimes.
 *
 * `queues` is STRUCTURAL: clients are options-derived providers, so
 * `forRootAsync` callers pass it alongside the factory —
 * `forRootAsync({ queues: ['email'], useFactory: () => ({ driver }) })`.
 * Async options are awaited during application initialization.
 */
const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = defineModule<QueueModuleOptions>({
  name: 'Queue',
  key: (o) =>
    stableHash({
      queues: o.queues ?? [],
      driver: driverIdentity(o.driver),
      dispatch: o.dispatch?.kind ?? 'direct',
    }),
  setup: ({ OPTIONS, options }) => {
    const queues = options.queues;
    const dispatch = options.dispatch;
    if (!queues || queues.length === 0) {
      throw new Error(
        "QueueModule requires 'queues' as a structural option: " +
          "QueueModule.forRoot({ queues: ['email'] }) — for forRootAsync, pass it alongside " +
          'the factory: forRootAsync({ queues: [...], useFactory }).',
      );
    }

    const clientProviders: ProviderDefinition[] = queues.map((name) =>
      defineProvider(queueToken(name), {
        useFactory: (driver: QueueDriver, _binding: QueueDispatchBinding) =>
          new QueueClient(name, driver),
        inject: [QUEUE_DRIVER, QueueDispatchBinding],
      }),
    );

    return {
      providers: [
        QueueTransportEntrypoints,
        defineProvider(QUEUE_DRIVER, {
          useFactory: (o: QueueModuleOptions) =>
            typeof o.driver === 'function' ? o.driver() : (o.driver ?? inline()),
          inject: [OPTIONS],
        }),
        defineProvider(QueueDispatchBinding, {
          useFactory: (container: Container, discovery: DiscoveryService, driver: QueueDriver) =>
            new QueueDispatchBinding(container, discovery, driver, queues, dispatch),
          inject: [Container, DiscoveryService, QUEUE_DRIVER],
        }),
        ...clientProviders,
      ],
      exports: [QUEUE_DRIVER, QueueDispatchBinding, ...queues.map((name) => queueToken(name))],
    };
  },
});

export class QueueModule extends ConfigurableModuleClass {}
export { MODULE_OPTIONS_TOKEN as QUEUE_MODULE_OPTIONS };
