---
"@velajs/cli": minor
---

**Behavior change:** `vela deploy check` checks Workers cron jobs only through `schedule:cron` rows. A snapshot that lists the removed `cf:scheduled` or `cf:vela-cron` kinds fails with `stale-entrypoint-snapshot` instead of counting them: entrypoint snapshots made by older CLIs must be regenerated with `vela entrypoint list --json`.

**Behavior change:** a `schedule:cron` row without a `dialect` whose weekday field has digits or whose day-of-month and weekday fields are both restricted (for example `0 9 * * 1` or `0 9 1 * MON`) fails with `ambiguous-cron-dialect`: Workers read the trigger with Cloudflare semantics while Node reads it as Unix cron, so the job fires on different days. Declare `{ dialect: 'cloudflare' }` on the `@Cron`.
