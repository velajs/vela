---
"@velajs/vela": minor
---

Add `invokeScheduledJob(container, entry, invocation, options?)`, the one dispatch primitive for scheduled jobs. The Node executor, the Cloudflare adapter's cron triggers and Studio's run-now all use it, so a job behaves the same wherever it fires: it is resolved by its owning module in a fresh invocation scope, receives only its `ScheduleInvocation`, honors `ScheduleModule.forRoot({ dispatch: { kind: 'signed' } })` through `InternalDispatcher` (the signed route runs its global guards), and a failure is reported once on the `schedule` edge and rethrown. `options.seed(scope)` lets a runtime seed request-scoped values, such as a native event token, into the job's scope. A custom runtime that fires scheduled jobs should call it.

Add `cronDialectAmbiguity(meta)`, which explains why a `@Cron` expression without a `dialect` fires on different days under Unix and Cloudflare semantics (a numeric weekday field, or both day fields restricted), or returns `undefined`.

**Behavior change:** `ScheduleNodeModule` reports such an ambiguous `@Cron` declaration at bootstrap through the diagnostics policy: it warns once in the default `'log'` mode and fails bootstrap in `'throw'` mode. Declare `{ dialect: 'unix' }` or `{ dialect: 'cloudflare' }` to keep the current days explicitly.

**Behavior change:** direct scheduled jobs run no guards, interceptors or filters on any runtime, neither app-global nor declared on the class, method or module, as with NestJS `@Cron`. Use signed dispatch to run a job through a route's request pipeline.

**Behavior change:** a scheduled job failure is reported with `source: 'Class.method'` (for example `'Reports.nightly'`) on every runtime; the Node executor previously reported only the method name.
