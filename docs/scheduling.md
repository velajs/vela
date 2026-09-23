# Scheduled work

Register jobs as normal injectable providers with `@Cron()` and `@Interval()`.
One contract applies on every runtime: Workers run `@Cron` jobs from native cron
triggers through `@velajs/cloudflare`, a Node host imports `ScheduleNodeModule`
from `@velajs/vela/schedule-node` to arm timers, and Studio's run-now uses the
same path. Portable code does not start timers by importing `ScheduleModule`.

## Portable jobs

A job receives exactly one argument, a `ScheduleInvocation`, on every runtime:

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

This class runs unchanged under `ScheduleNodeModule` and under a Workers cron
trigger declared as `0 9 * * MON-FRI`. The invocation carries `kind`
(`'cron'` or `'interval'`), the `expression` (or `ms` for an interval),
`scheduledTime` in Unix milliseconds, and a `signal` that aborts when the
application closes. It has no platform fields; inject what a job needs instead:
bindings through `ENV`, background work through `EXECUTION_LIFETIME`, and
Cloudflare trigger controls through `CLOUDFLARE_SCHEDULED_EVENT`.

Every runtime dispatches through `invokeScheduledJob(container, entry,
invocation)` from `@velajs/vela`. It resolves the job by its owning module in a
fresh invocation scope, calls the method with only the invocation, reports a
failure once on the `schedule` edge and rethrows it. A direct job runs no guards,
interceptors or filters, neither app-global nor declared on its class, method or
module, as with NestJS `@Cron`: a tick has no caller to authorize. Opt into
signed dispatch (below) when a job should run through the request pipeline.

## Cron dialects

Without options, `@Cron(expression)` and `parseCron(expression)` use the Unix
dialect: local time, weekday numbers where 0 or 7 is Sunday, and both
day-of-month and weekday must match when both are restricted. The Cloudflare
dialect uses UTC and numbers weekdays from 1 (Sunday) through 7 (Saturday); when
both day fields are restricted, either may match. It accepts named
months/weekdays, lists, ranges including wrap-around, steps, and calendar forms
`L`, `LW`, `L-n`, `L-nW`, `nW`, `nL` and `n#k`. Cloudflare with
`timeZone: 'local'` is invalid. Unix schedules can set `timeZone: 'UTC'`
explicitly without changing weekday numbering. `parseCron(expression, options)`
returns a matcher or `null`. It rejects malformed decimal fields instead of
coercing values such as `0x10`. Unix ranges ending at Sunday (for example `5-7`)
retain all their days; a start with a step (`5/15` minutes) extends through the
field's maximum.

Declare `dialect` whenever a schedule could run on Workers. A Workers trigger is
always read with Cloudflare semantics, so an expression without a dialect whose
weekday field uses numbers, or which restricts both day fields, fires on
different days under Node and under Workers. `cronDialectAmbiguity(meta)`
explains that ambiguity (or returns `undefined`), and both runtimes report it at
bootstrap through the diagnostics policy.

`@Cron` validates explicit options at decoration time. A bare decorator defers
runtime-specific syntax validation. Node validates all jobs before starting any
timers and reports invalid expressions instead of silently dropping them.
`@Interval(ms)` requires an integer from 1 through 2147483647; invalid/overflow
delays cannot become a rapid 1 ms timer accidentally.

## Workers cron triggers

Declare each job's exact expression under Wrangler `triggers.crons` for the
deployed environment; the decorator does not provision a trigger. The adapter
finds `@Cron` jobs from their metadata, so `ScheduleModule` is needed only for
`ScheduleRegistry` or signed dispatch. The Cloudflare
adapter runs every `@Cron` job whose expression is exactly the delivered trigger
string, including whitespace; it never re-evaluates the delivery date.

```ts
import {
  Cron,
  EXECUTION_LIFETIME,
  Inject,
  Injectable,
  Scope,
  type ExecutionLifetime,
  type ScheduleInvocation,
} from '@velajs/vela';
import { CLOUDFLARE_SCHEDULED_EVENT, type CloudflareScheduledEvent } from '@velajs/cloudflare';

@Injectable({ scope: Scope.REQUEST })
class Exports {
  constructor(
    @Inject(CLOUDFLARE_SCHEDULED_EVENT) private readonly trigger: CloudflareScheduledEvent,
    @Inject(EXECUTION_LIFETIME) private readonly lifetime: ExecutionLifetime,
  ) {}

  @Cron('30 2 * * *', { dialect: 'cloudflare' })
  async nightly(tick: ScheduleInvocation) {
    const response = await fetch('https://example.com/export', { signal: tick.signal });
    if (response.status === 410) this.trigger.noRetry();
    this.lifetime.waitUntil(fetch('https://example.com/export/notify', { method: 'POST' }));
  }
}
```

`CLOUDFLARE_SCHEDULED_EVENT` is request-scoped and resolves only inside a
scheduled invocation. It carries the trigger's `cron`, `scheduledTime` and a
`noRetry()` already bound to the native controller, so it can be destructured or
passed on. `EXECUTION_LIFETIME.waitUntil()` and `defer()` extend the invocation:
the trigger settles only after every matching job and its managed work settle.
One failing job does not cut off its siblings or dispose their resources early.
A single failure rejects the trigger; several reject it together as an
`AggregateError`.

The adapter reports declarations a trigger cannot honor through the container's
diagnostics policy: a cron without a dialect that is ambiguous as described
above, an explicit `dialect: 'unix'` or `timeZone: 'local'`, and `@Interval` jobs,
which never run on Workers. The default `'log'` mode warns once per declaration
and never fails the first event, which is where a Worker bootstraps; `'throw'`
fails bootstrap. `vela deploy check` rejects the same declarations before
deployment; see [deployment](deployment.md).

## Signed dispatch

`ScheduleModule.forRoot({ dispatch: { kind: 'signed', target } })` makes every
fired job re-enter a `@SignedInvocation()` route through `InternalDispatcher`
instead of calling the method. The route runs the full request pipeline,
including global guards. This works the same on Node timers, Workers cron
triggers (the Cloudflare adapter supplies the in-isolate transport and reads
`URL_SIGNING_SECRET` from `ENV`) and Studio's run-now. `target(job)` receives
`{ kind, methodName, expression }` for a cron job or `{ kind, methodName, ms }` for
an interval.

## Introspection

For deployment tools, entrypoints expose `schedule:cron` metadata
`{ expression, methodName, dialect?, timeZone? }` and `schedule:interval` metadata
`{ ms, methodName }`. `parseCronMetadata` and `parseIntervalMetadata` validate
unknown introspection data without constructing job providers. These are the only
schedule kinds; regenerate entrypoint snapshots made by older CLIs.

## Lifetime and delivery

Each invocation resolves the job by its owning module inside a fresh invocation
scope. Request-scoped and transient providers are constructed for that invocation;
singletons retain their normal application lifetime. Handlers that declare no
parameter still work. No HTTP identity is inferred.

Closing the application stops future timers, aborts active invocation signals,
and waits for jobs and managed deferred work to settle before disposing
invocation resources. A job that stops by throwing its signal's abort reason is
cancelled, not failed. Signed dispatch forwards cancellation to its transport;
cancelling the caller cannot guarantee that remote side effects stop. Handlers
must cooperate with cancellation or finish on their own; shutdown does not
dispose resources underneath running code. Overlap between ticks remains allowed.
There is no implicit catch-up or automatic retry on Node. Failures are reported
through the existing exception reporter. On Node with `diagnostics: 'throw'`, the
first failure stops new timers and is rethrown by `app.close()` after active work
settles; timer callbacks do not produce unhandled rejections.

Use the existing workflow binding/step APIs for durable work, and explicitly
admit a tenant for background tenant operations. Distributed claims or leases
belong to an optional atomic storage integration. An in-memory timer, run-history
row, or per-event concurrency limit cannot provide distributed deduplication or
exactly-once side effects. Native Workflow schedules can avoid an intermediate
cron handler when the workflow needs no custom trigger processing.

See Cloudflare's [cron syntax](https://developers.cloudflare.com/workers/configuration/cron-triggers/),
[Saffron parser](https://github.com/cloudflare/saffron),
[scheduled handler contract](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/),
and [Workflow schedules](https://developers.cloudflare.com/workflows/build/trigger-workflows/)
for deployment constraints and current platform behavior.
