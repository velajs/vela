---
"@velajs/cloudflare": minor
---

Cron triggers run core `@Cron()` jobs through `invokeScheduledJob`, the same primitive as the Node executor: the adapter runs every `@Cron` job whose expression is exactly the trigger string, in a fresh invocation scope, and the trigger settles after every matching job and its `EXECUTION_LIFETIME` work settle. Closing the application aborts the invocation signal of running jobs and waits for them.

Add `CLOUDFLARE_SCHEDULED_EVENT`, a request-scoped token seeded into each job's invocation scope. Its `CloudflareScheduledEvent` value carries the trigger's `cron`, `scheduledTime` and a `noRetry()` already bound to the native controller. The token provides itself as request-scoped in every container, so a class that injects it is request-scoped wherever the module graph boots, including a `VelaWebSocketDurableObject`, `vela` CLI commands and `Test.createTestingModule()`, and is constructed per invocation instead of at bootstrap; resolving it outside a scheduled invocation throws. `ScheduledEvent` (the input of `scheduled()`) now also accepts the controller's optional `noRetry`.

Signed `ScheduleModule` dispatch now works on Workers: the adapter's invocation transport re-enters the signed route, so its global guards run.

The adapter reports schedule declarations a cron trigger cannot honor through the diagnostics policy: a `@Cron` without a dialect whose weekday field has digits or whose day fields are both restricted, `dialect: 'unix'`, `timeZone: 'local'`, `@Interval` jobs, which never run on Workers, and `@UseGuards`, `@UseInterceptors` or `@UseFilters` declared for a cron job. The default `'log'` mode warns once per declaration and never fails the first event; `'throw'` fails bootstrap. `vela deploy check` rejects the cron declarations and `@Interval` jobs before deployment (`ambiguous-cron-dialect`, `incompatible-cron-options`, `unsupported-interval`).

The adapter provides `SCHEDULE_INVOCATION_SEED`: a cron job fired outside a trigger, such as by Studio's run-now, receives a synthetic `CLOUDFLARE_SCHEDULED_EVENT` whose `cron` is the job's expression, whose `scheduledTime` is the invocation's, and whose `noRetry()` does nothing.

**Behavior change:** `@Scheduled` and `parseScheduledMetadata` are removed, along with the `ScheduledMetadata`, `ScheduledController`, `ScheduledContext` and `ScheduledHandler` types and the `cf:scheduled` and `cf:vela-cron` entrypoint kinds. Replace `@Scheduled(expr)` with `@Cron(expr, { dialect: 'cloudflare' })` from `@velajs/vela`. Cron jobs appear only as `schedule:cron` entrypoints.

**Behavior change:** scheduled handlers receive only a `ScheduleInvocation` (`kind`, `expression` equal to the trigger string, `scheduledTime`, `signal`), identical to Node, instead of `(controller, env, ctx)`. Inject `ENV` for bindings, `CLOUDFLARE_SCHEDULED_EVENT` for `noRetry()`, and `EXECUTION_LIFETIME` for `waitUntil()`.

**Behavior change:** scheduled jobs no longer run interceptors or filters declared with `@UseInterceptors` or `@UseFilters`, matching the Node executor. A job that declares `@UseGuards` on its class, method or module, whose guards the adapter used to run on each trigger, is now refused instead of running unguarded: the trigger fails, the job is never constructed, and the refusal is reported through the exception reporter (guards do not run for directly dispatched scheduled jobs — use `ScheduleModule.forRoot({ dispatch: { kind: 'signed', ... } })` or remove the guard). Other jobs on the same trigger still run. Queue consumers keep their guards, interceptors and filters. Use signed `ScheduleModule` dispatch to run a job through a route's request pipeline, or remove the guard.

**Behavior change:** a `@Cron` job that declares `@UseGuards`, `@UseInterceptors` or `@UseFilters` on its class, method or module is reported through the diagnostics policy, because those components never run for scheduled jobs: the default `'log'` mode warns once and `'throw'` fails bootstrap. Move them to a signed `ScheduleModule` dispatch route.
