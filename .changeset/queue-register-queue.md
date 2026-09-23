---
"@velajs/vela": minor
---

Add Nest-style queue registration to `@velajs/vela/queue`. `QueueModule.forRoot({ driver, dispatch })` configures the application's driver once and is global; `QueueModule.registerQueue({ name, binding?, consumer? })` registers a queue in the module that uses it and provides its `QueueClient`, which `@InjectQueue(name)` injects (the same as `@Inject(queueToken(name))`). `registerQueue` accepts several queues in one call. Registering one queue in several modules is fine: registrations are merged by name, their `consumer` pins accumulate, and two different bindings for the same name fail bootstrap. `QueueRegistry` (exported by the module) lists the merged registrations, and each registered queue is published as a portable `queue:registration` entrypoint (`{ name, binding?, consumers }`) for deployment checks.

Add `QueueClient.addBulk(jobs)`, which validates every typed job before any is sent, then hands the whole batch to the new optional `QueueDriver.enqueueBatch(requests)`, or enqueues one job at a time when the driver has none. It resolves only when every job was accepted; otherwise it rejects with a `QueueBatchError` whose `accepted` and `rejected` list the job ids.

A driver factory (`driver: (context) => QueueDriver`) now receives a `QueueDriverContext`: the application's `ENV`, when a runtime seeded one, and its `QueueRegistry`. A factory still builds a fresh driver for each application.

**Behavior change:** `QueueModuleOptions.queues` is removed, from `forRoot` and `forRootAsync` alike. Replace `QueueModule.forRoot({ queues: ['email'], driver })` with `QueueModule.forRoot({ driver })` plus `QueueModule.registerQueue({ name: 'email' })` in the module that produces or processes the queue. `forRoot()` takes no required options, is global, and is imported once per application: two different `forRoot` configurations now fail bootstrap. `dispatch` may now come from a `forRootAsync` factory.

**Behavior change:** `QueueDispatchBinding.dispatch(job)`, the entry point for platform deliveries, rejects a job whose queue is not registered in the application, so the platform retries it instead of acknowledging it. The binding's constructor takes the application's `QueueRegistry` instead of a list of queue names.

**Behavior change:** `QueueDriverEntrypoint` no longer has a `queue` field; a driver's platform routes carry only `kind` and `meta`.
