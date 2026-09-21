import { Container, defineModule, defineProvider, DiscoveryService, stableHash } from '../index';
import type { ProviderDefinition } from '../index';
import { inline } from './inline.driver';
import { QueueClient } from './queue.client';
import { QueueDispatchBinding } from './queue.binding';
import { QUEUE_DRIVER, queueToken } from './queue.tokens';
import type { QueueDriver, QueueModuleOptions } from './queue.types';

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
 * `lazy: true` (dogfoods 1.13): the module materializes when an eager
 * producer injects a client (bootstrap — same structural reality that keeps
 * WebSocketModule eager) or, in consumer-only workers, at the first
 * delivered job.
 *
 * `queues` is STRUCTURAL: clients are options-derived providers, so
 * `forRootAsync` callers pass it alongside the factory —
 * `forRootAsync({ queues: ['email'], useFactory: () => ({ driver }) })`.
 * Note that async options inherit the 1.13 lazy-module contract: the module
 * must first materialize through an async seam (an eager producer's injection
 * during the bootstrap sweep — the common case — or
 * `app.materializeLazyModules()`); a synchronous first touch throws the
 * descriptive sync-seam error.
 */
const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = defineModule<QueueModuleOptions>({
  name: 'Queue',
  lazy: true,
  key: (o) =>
    stableHash({
      queues: o.queues ?? [],
      driver: typeof o.driver === 'function' ? o.driver : (o.driver?.kind ?? 'inline'),
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
