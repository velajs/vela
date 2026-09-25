---
'@velajs/cli': minor
---

`vela cf sync` keeps the cron triggers no `@Cron` job declares: a Worker entry with its own `scheduled` handler may serve them. It reports each one as `triggers.crons: "30 5 * * *" is not declared by any @Cron job; kept (pass --prune to remove it).` The new `--prune` flag removes them, and lists their removal when comparing.

**Behavior change:** `vela cf sync --write` no longer deletes cron triggers that no `@Cron` job declares, and a comparison no longer fails on them; pass `--prune` for the previous behavior.
