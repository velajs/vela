---
"@velajs/studio": minor
---

**Behavior change:** `schedule.runNow` runs the job through `invokeScheduledJob`, exactly as a timer or cron trigger would. The job receives a `ScheduleInvocation` (with `scheduledTime` set to now) instead of no arguments, runs in a fresh invocation scope so request-scoped jobs can be run, and re-enters its signed route when the application uses signed `ScheduleModule` dispatch. Interval jobs can be run too.
