---
"@velajs/cli": minor
---

**Behavior change:** `vela deploy check` checks Workers cron jobs only through `schedule:cron` rows. A snapshot that lists the removed `cf:scheduled` or `cf:vela-cron` kinds fails with `stale-entrypoint-snapshot` instead of counting them: entrypoint snapshots made by older CLIs must be regenerated with `vela entrypoint list --json`.

**Behavior change:** a `schedule:cron` row without a `dialect` whose weekday field has digits or whose day-of-month and weekday fields are both restricted (for example `0 9 * * 1` or `0 9 1 * MON`) fails with `ambiguous-cron-dialect`: Workers read the trigger with Cloudflare semantics while Node reads it with Vela's unix dialect, so the job fires on different days. Declare `{ dialect: 'cloudflare' }` on the `@Cron`; `{ dialect: 'unix' }` is only for Node-only jobs, which are not deployed as Workers.

**Behavior change:** `vela entrypoint list` adds `guards: true` to the metadata of a `schedule:cron` or `schedule:interval` row whose job declares `@UseGuards` on its class, method or module, and `dispatch: 'signed'` to every scheduled row when `ScheduleModule.forRoot({ dispatch: { kind: 'signed' } })` is configured. `vela deploy check` fails a `schedule:cron` row marked `guards: true` without `dispatch: 'signed'` with `scheduled-job-guards`: guards do not run for directly dispatched scheduled jobs, so the Worker refuses to run the job on every trigger. Use signed dispatch or remove the guard, and regenerate the snapshot.
