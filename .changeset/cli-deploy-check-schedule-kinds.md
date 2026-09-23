---
"@velajs/cli": minor
---

**Behavior change:** `vela deploy check` checks Workers cron jobs only through `schedule:cron` rows. A snapshot that lists the removed `cf:scheduled` or `cf:vela-cron` kinds fails with `stale-entrypoint-snapshot` instead of counting them: entrypoint snapshots made by older CLIs must be regenerated with `vela entrypoint list --json`.
