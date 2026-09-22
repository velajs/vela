import { defineProvider } from '../container/types';
import { Module } from '../module/decorators';
import { stableHash } from '../module/stable-hash';
import type { DynamicModule } from '../module/types';
import { ScheduleRegistry } from './schedule.registry';
import { SCHEDULE_DISPATCH } from './schedule.tokens';
import type { ScheduleDispatchMode } from './schedule.types';

/**
 * Dedicated host for the dispatch policy. `forRoot({ dispatch })` contributes
 * `SCHEDULE_DISPATCH` through THIS class rather than through `ScheduleModule`
 * for two reasons:
 *
 *  1. The only consumers (the schedule-node executor today, a CF executor
 *     later) live in OTHER modules, so the token must be GLOBAL — and a
 *     dynamic module's `global: true` globalizes ALL its exports. Riding a
 *     single-token host keeps the globalization scoped to just the policy
 *     (mirrors how `InternalDispatcher` is a global token).
 *  2. Re-using `module: ScheduleModule` would re-declare `ScheduleRegistry`,
 *     which fights the executor module's own copy and suppresses the
 *     executor's eager bootstrap — so the policy host provides NO registry.
 *
 * Undecorated on purpose: the loader auto-registers empty metadata for a class
 * used only as a dynamic module's `module`.
 */
class ScheduleDispatchHost {}

/**
 * Zero-config module (Tier C): providers live on the `@Module` bag; the
 * `forRoot()` static is NestJS-parity sugar returning the bare dynamic module
 * (default key — repeated calls dedup).
 *
 * `forRoot({ dispatch })` OPTS IN to signed re-entry for scheduled jobs
 * (`ctx.run`): it contributes a GLOBAL `SCHEDULE_DISPATCH` policy the
 * schedule-node executor reads `@Optional`ly (pair it with
 * `ScheduleNodeModule` for the node runtime). The Cloudflare adapter rejects a
 * signed policy at bootstrap until its cron dispatch honors it. With no options
 * the behavior is unchanged (direct in-isolate method calls).
 */
@Module({
  // Lazy: the @Cron/@Interval discovery pass runs when ScheduleRegistry is
  // first resolved (executor bootstrap, introspection, first dispatch).
  lazy: true,
  providers: [ScheduleRegistry],
  exports: [ScheduleRegistry],
})
export class ScheduleModule {
  static forRoot(options: { dispatch?: ScheduleDispatchMode } = {}): DynamicModule {
    const dispatch = options.dispatch;
    if (!dispatch) return { module: ScheduleModule };
    return {
      module: ScheduleDispatchHost,
      key: stableHash({ dispatch: dispatch.kind }),
      providers: [defineProvider(SCHEDULE_DISPATCH, { useValue: dispatch })],
      exports: [SCHEDULE_DISPATCH],
      global: true,
    };
  }
}
