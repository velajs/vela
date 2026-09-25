# Scheduling — Cron & Intervals

Vela splits scheduling into an **edge-safe registry** (`ScheduleModule`, subpath `@velajs/vela/schedule` — discovers jobs, never arms a timer) and a **Node/Bun executor** (`ScheduleNodeModule`, subpath `@velajs/vela/schedule-node` — arms `setInterval` to actually run them). This keeps `setInterval` out of edge-safe core.

## Declaring jobs

`@Cron(expression, options?)` and `@Interval(ms)` are method decorators on any `@Injectable()` provider. Cron options select `dialect: 'unix' | 'cloudflare'` and `timeZone: 'local' | 'UTC'`. A job receives exactly one argument, its invocation (`kind`, `expression` or `ms`, `scheduledTime`, `signal`), identically on Node, Workers and Studio's run-now: `CronInvocation` for `@Cron`, `IntervalInvocation` for `@Interval` (both members of `ScheduleInvocation`). The decorators are typed, so a method with another required parameter (such as native `(controller, env, ctx)`) or a first parameter that is not the invocation does not compile:

```ts
import { Cron, Interval, type CronInvocation } from '@velajs/vela/schedule';

@Injectable()
class MaintenanceJobs {
  @Cron('0 9 * * MON-FRI', { dialect: 'cloudflare' }) // portable: Node timers and Workers triggers
  async morning(tick: CronInvocation) {
    await fetch('https://example.com/reports', { signal: tick.signal });
  }

  @Interval(30_000)      // every 30s (milliseconds); Node only
  poll() { /* ... */ }
}
```

As in NestJS, `applyDecorators(Cron(...), SetMetadata(...))` composes these decorators but does not check the handler's signature; only a directly applied `@Cron`/`@Interval` does.

The default unix dialect uses five fields with lists (`,`), ranges (`a-b`), and steps (`*/n`); both `0` and `7` are Sunday. It preserves the 1.x local-time default. When both day fields are restricted, Vela's unix dialect requires both to match; standard crontab and Cloudflare fire when either matches. Cloudflare uses UTC and weekday numbers `1` (Sunday) through `7` (Saturday). Always declare `dialect` for a schedule that can run on Workers (`{ dialect: 'cloudflare' }` for portable jobs, `{ dialect: 'unix' }` only for Node-only jobs): without it, a numeric weekday or two restricted day fields fire on different days per runtime, both runtimes report that through diagnostics (`cronDialectAmbiguity(meta)` explains it), and `vela deploy check` fails with `ambiguous-cron-dialect`. A cron with neither `dialect` nor `timeZone` runs at local time on Node but UTC on Workers; `ScheduleNodeModule` reports it when the process time zone is not UTC.

All runtimes dispatch through `invokeScheduledJob(container, entry, invocation)`: a fresh invocation scope in the job's owning module, the invocation as the only argument, one report on the `schedule` edge, rethrow. Direct jobs run **no** guards, interceptors or filters (global or scoped), as with NestJS `@Cron`. A direct job that declares `@UseGuards` on its class, method or module **fails closed**: `invokeScheduledJob` refuses it (reported through the exception reporter: guards do not run for directly dispatched scheduled jobs — use `ScheduleModule.forRoot({ dispatch: { kind: 'signed', ... } })` or remove the guard) on Node, Workers and Studio's run-now, and `vela deploy check` fails with `scheduled-job-guards`. Declared interceptors/filters stay a diagnostic: both runtimes report `@UseGuards`/`@UseInterceptors`/`@UseFilters` at bootstrap (`scheduledJobComponents(container, entry)` lists them). `ScheduleModule.forRoot({ dispatch: { kind: 'signed', target } })` re-enters a `@SignedInvocation()` route through `InternalDispatcher` on every runtime, so global guards apply. Import it once, in the root module: a signed policy compares by reference, so re-importing the same policy object deduplicates, while a different kind or another signed policy object fails bootstrap, even one a helper builds from the same source with another captured target.

A caller that fires a job on demand (Studio's run-now) passes the runtime's optional `SCHEDULE_INVOCATION_SEED` to `invokeScheduledJob` as `seed`, so the job's scope holds what a trigger would seed (on Workers, a synthetic `CLOUDFLARE_SCHEDULED_EVENT` whose `noRetry()` does nothing).

## Edge-safe registry (`ScheduleModule`)

On edge runtimes, import `ScheduleModule` and let the platform's cron trigger drive execution. `ScheduleModule.forRoot()` provides `ScheduleRegistry`, which **lists** discovered jobs but never runs a timer; `forRoot({ dispatch })` opts into signed dispatch:

```ts
import { ScheduleModule, ScheduleRegistry } from '@velajs/vela/schedule';

@Module({ imports: [ScheduleModule.forRoot()], providers: [MaintenanceJobs] })
class AppModule {}

// inspect registered jobs
const registry = app.get(ScheduleRegistry);
registry.getCronEntrypoints();      // [{ expression, methodName, instance, target }]
registry.getIntervalEntrypoints();  // [{ ms, methodName, instance, target }]
registry.getCronEntrypoints(); // owner-bearing metadata, including async/request providers
registry.getIntervalEntrypoints();
```

On Cloudflare Workers, `@velajs/cloudflare` runs every `@Cron` job whose expression is exactly the delivered trigger string from the Workers `scheduled()` handler — you declare the trigger in the Wrangler file, not `setInterval`. There is no separate Cloudflare cron decorator. Inject `CLOUDFLARE_SCHEDULED_EVENT` (request-scoped) for `noRetry()`; `@Interval` never runs on Workers. See `cloudflare.md`.

## Node/Bun executor (`@velajs/vela/schedule-node`)

For Node or Bun, import `ScheduleNodeModule` instead. It provides both `ScheduleRegistry` and `ScheduleExecutor`; the executor arms real timers on bootstrap and clears them on shutdown. It takes no options: `ScheduleNodeModule.forRoot()` and the bare `ScheduleNodeModule` are one instance, so a library importing one form and the app the other still run each job once:

```ts
import { ScheduleNodeModule, ScheduleExecutor } from '@velajs/vela/schedule-node';

@Module({
  imports: [ScheduleNodeModule.forRoot()],
  providers: [MaintenanceJobs],
})
class AppModule {}

const app = await VelaFactory.create(AppModule);
// @Interval jobs fire on setInterval; @Cron jobs are checked every second against the matcher
```

`ScheduleExecutor` throws at bootstrap if `setInterval` is unavailable (message: *"@velajs/vela/schedule-node requires Node or Bun. Use a platform cron adapter on edge runtimes"*). Do **not** import this subpath in Cloudflare Workers / Deno Deploy / Vercel Edge — it is excluded from the edge-runtime audit by design.

Node execution resolves each handler in a fresh managed child using its module
owner. It awaits asynchronous providers and managed work, then disposes the
child. Shutdown stops new timer admissions, aborts active signals and drains
accepted invocations. Native Workers dispatch uses the delivered trigger's exact
expression and its own child/environment; it does not run a local timer matcher,
and closing the application aborts active signals too. Keep distributed locking
and durable execution history explicit application integrations.

## Which to use

| Runtime | Import | Runs jobs |
|---|---|---|
| Cloudflare Workers / Deno / Vercel Edge | `ScheduleModule` + platform cron adapter | platform `scheduled()` trigger |
| Node / Bun (long-lived process) | `ScheduleNodeModule` | `ScheduleExecutor` (`setInterval`) |
