# Scheduled work

Register jobs as normal injectable providers. Workers execute `@Scheduled()` and
core `@Cron()` methods through native cron triggers. A Node host additionally
imports `ScheduleNodeModule` from `@velajs/vela/schedule-node`; portable code does
not start timers by importing `ScheduleModule`.

## Cron dialects

Existing Node `@Cron(expression)` and `parseCron(expression)` use local time,
Unix weekday numbers (0 or 7 is Sunday), and require both day-of-month and
weekday fields to match when both are restricted. These 1.x defaults remain.
Set options explicitly when a schedule must be portable:

```ts
import { Cron, Injectable, type ScheduleInvocation } from '@velajs/vela';

@Injectable()
class Reports {
  @Cron('0 9 * * MON-FRI', { dialect: 'cloudflare' })
  async morning(tick: ScheduleInvocation) {
    await fetch('https://example.com/reports', { signal: tick.signal });
  }
}
```

The Cloudflare dialect uses UTC and numbers weekdays from 1 (Sunday) through 7
(Saturday). It accepts named months/weekdays, lists, ranges, steps, and calendar
forms `L`, `LW`, `nW`, `nL` and `n#k`. Cloudflare with `timeZone: 'local'` is
invalid. Unix schedules can set `timeZone: 'UTC'` explicitly without changing
weekday numbering. `parseCron(expression, options)` returns a matcher or `null`.
It rejects malformed decimal fields instead of coercing values such as `0x10`.
Unix ranges ending at Sunday (for example `5-7`) retain all their days; a start
with a step (`5/15` minutes) extends through the field's maximum.

`@Cron` validates explicit options at decoration time. A bare decorator defers
runtime-specific syntax validation so existing native Workers expressions remain
usable. Node validates all jobs before starting any timers and reports invalid
expressions instead of silently dropping them. `@Interval(ms)` requires an
integer from 1 through 2147483647; invalid/overflow delays cannot become a rapid
1 ms timer accidentally.

## Native Workers

```ts
import { Injectable } from '@velajs/vela';
import { Scheduled, type ScheduledController } from '@velajs/cloudflare';

@Injectable()
class NativeReports {
  @Scheduled('0 9 * * MON-FRI')
  async run(controller: ScheduledController) {
    console.log(controller.scheduledTime);
  }
}
```

Configure the same exact expression under Wrangler `triggers.crons` for the
deployed environment. Neither decorator provisions a trigger. Native dispatch
compares the complete expression string, including whitespace; it does not
re-evaluate the event's delivery date. `@Scheduled` validates Cloudflare syntax.
`ScheduledController`, `ScheduledContext` and `ScheduledHandler<Env>` provide
structural types for native handlers. `ScheduledEvent` retains optional
`scheduledTime` for existing programmatic calls. Native events are forwarded
unchanged; call `controller.noRetry()` on the controller rather than extracting
an unbound method.

For deployment tools, entrypoints expose `schedule:cron` metadata
`{ expression, methodName, dialect?, timeZone? }` and `schedule:interval` metadata
`{ ms, methodName }`. Cloudflare also exposes its existing `cf:scheduled` and
`cf:vela-cron` views. Deduplicate expressions across views; they are not extra
invocations. `parseCronMetadata`, `parseIntervalMetadata`, and Cloudflare's
`parseScheduledMetadata` validate unknown introspection data without constructing
job providers. Workers do not run `@Interval` timers.

## Lifetime and delivery

Node resolves each job by its owning module inside a fresh invocation scope.
Request-scoped and transient providers are constructed for that invocation;
singletons retain their normal application lifetime. Existing zero-argument
handlers still work. Direct Node handlers receive an optional-to-consume first
`ScheduleInvocation` argument with a discriminated kind, period/expression,
`scheduledTime`, and cooperative cancellation signal. No HTTP identity is
inferred, and Node direct invocation does not add HTTP guards or interceptors.
Signed dispatch remains opt-in for work that should use the request pipeline.

Closing the application stops future timers, aborts active invocation signals,
and waits for direct handlers and managed deferred work to settle before disposing
invocation resources. Signed dispatch forwards cancellation to its transport;
cancelling the caller cannot guarantee that remote side effects stop. Handlers must cooperate with cancellation or finish on
their own; shutdown does not dispose resources underneath running code. Overlap
between ticks remains allowed. There is no implicit catch-up or automatic retry.
Failures are reported through the existing exception reporter. With
`diagnostics: 'throw'`, the first failure stops new timers and is rethrown by
`app.close()` after active work settles; timer callbacks do not produce unhandled
rejections.

Use the existing workflow binding/step APIs for durable work, and explicitly
admit a tenant for background tenant operations. Distributed claims or leases
belong to an optional atomic storage integration. An in-memory timer, run-history
row, or per-event concurrency limit cannot provide distributed deduplication or
exactly-once side effects. Native Workflow schedules can avoid an intermediate
cron handler when the workflow needs no custom trigger processing.

See Cloudflare's [cron syntax](https://developers.cloudflare.com/workers/configuration/cron-triggers/),
[scheduled handler contract](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/),
and [Workflow schedules](https://developers.cloudflare.com/workflows/build/trigger-workflows/)
for deployment constraints and current platform behavior.
