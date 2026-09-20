# Scheduler Node Jobs

Fake consumer project for the opt-in `@velajs/vela/schedule-node` subpath installed through `file:../..`.

```sh
pnpm --dir examples/scheduler-node-jobs install
pnpm --dir examples/scheduler-node-jobs typecheck
pnpm --dir examples/scheduler-node-jobs test
pnpm --dir examples/scheduler-node-jobs smoke
```

Covered behaviors:

- `ScheduleNodeModule.forRoot()`.
- `ScheduleExecutor` registration.
- `@Interval()` execution on Node timers.
- `@Cron()` execution through the Node scheduler.
- Timer cleanup when `app.close()` runs.
