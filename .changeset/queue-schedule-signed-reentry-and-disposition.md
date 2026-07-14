---
"@velajs/vela": minor
---

Adopt the `ctx.run` signed re-entry seam in QueueModule and ScheduleModule, and add a queue disposition harness.

- **Opt-in signed dispatch (default off, additive).** `QueueModule.forRoot({ dispatch: { kind: 'signed', target } })` and `ScheduleModule.forRoot({ dispatch: { kind: 'signed', target } })` re-enter a user-authored `@SignedInvocation()` route through `InternalDispatcher.run()` instead of the direct in-isolate `@Processor`/decorated-method path, so the job runs the full request pipeline (global guards/interceptors/filters). Absent (or `{ kind: 'direct' }`) keeps today's behavior exactly; `dispatch.kind` participates in the QueueModule dedup key. The schedule-node `ScheduleExecutor` reads the policy via an `@Optional` global `SCHEDULE_DISPATCH` token.
- **Queue disposition harness** (`@velajs/vela/queue`): `observeMessage`/`observeBatch` WRAP (never mutate) a non-extensible host queue `Message` in a Proxy to record `ack`/`retry` outcomes and honestly infer `deadLettered` when the observer supplies `maxRetries` (`undefined` when unknown, never a misleading `false`). Platform-neutral testing/observability seam; not wired into any delivery path.
