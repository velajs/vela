# Scheduling — Cron & Intervals

Vela splits scheduling into an **edge-safe registry** (`ScheduleModule`, main export — discovers jobs, never arms a timer) and a **Node/Bun executor** (`ScheduleNodeModule`, subpath `@velajs/vela/schedule-node` — arms `setInterval` to actually run them). This keeps `setInterval` out of edge-safe core.

## Declaring jobs

`@Cron(expression)` and `@Interval(ms)` are method decorators on any `@Injectable()` provider. Neither takes a name or options argument:

```ts
import { Cron, Interval } from '@velajs/vela';

@Injectable()
class MaintenanceJobs {
  @Cron('0 * * * *')     // standard 5-field cron: minute hour day month weekday
  hourly() { /* ... */ }

  @Interval(30_000)      // every 30s (milliseconds)
  poll() { /* ... */ }
}
```

Cron format is the standard 5 fields with lists (`,`), ranges (`a-b`), and steps (`*/n`); both `0` and `7` are Sunday.

## Edge-safe registry (`ScheduleModule`)

On edge runtimes, import `ScheduleModule` and let the platform's cron trigger drive execution. `ScheduleModule.forRoot()` takes no options; it provides `ScheduleRegistry`, which **lists** discovered jobs but never runs a timer:

```ts
import { ScheduleModule, ScheduleRegistry } from '@velajs/vela';

@Module({ imports: [ScheduleModule.forRoot()], providers: [MaintenanceJobs] })
class AppModule {}

// inspect registered jobs
const registry = app.get(ScheduleRegistry);
registry.getCronJobs();      // [{ expression, methodName, instance, target }]
registry.getIntervalJobs();  // [{ ms, methodName, instance, target }]
```

On Cloudflare Workers, `@velajs/cloudflare` (≥ 0.2.0) dispatches `@Cron` jobs from the Workers `scheduled()` handler — you configure the trigger in `wrangler.toml`, not `setInterval`.

## Node/Bun executor (`@velajs/vela/schedule-node`)

For Node or Bun, import `ScheduleNodeModule` instead. It provides both `ScheduleRegistry` and `ScheduleExecutor`; the executor arms real timers on bootstrap and clears them on shutdown:

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

## Which to use

| Runtime | Import | Runs jobs |
|---|---|---|
| Cloudflare Workers / Deno / Vercel Edge | `ScheduleModule` + platform cron adapter | platform `scheduled()` trigger |
| Node / Bun (long-lived process) | `ScheduleNodeModule` | `ScheduleExecutor` (`setInterval`) |
