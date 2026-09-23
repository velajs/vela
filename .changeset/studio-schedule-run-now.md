---
"@velajs/studio": minor
---

**Behavior change:** `schedule.runNow` runs the job through `invokeScheduledJob`, the primitive timers and cron triggers use. The job receives a `ScheduleInvocation` (with `scheduledTime` set to the time of the run) instead of no arguments, runs in a fresh invocation scope so request-scoped jobs can be run, and re-enters its signed route when the application uses signed `ScheduleModule` dispatch. Interval jobs can be run too. What a native trigger seeds into the job's scope comes from the runtime's `SCHEDULE_INVOCATION_SEED`: on Workers the job receives a synthetic `CLOUDFLARE_SCHEDULED_EVENT` whose `noRetry()` does nothing, so a job that injects it runs instead of failing. Unlike a trigger, the run completes inside the Studio request, and a failure is returned to the caller rather than retried by the platform. Closing the application aborts the signal of a run still in progress and waits for it.
