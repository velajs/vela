import { Container } from '../container/container';
import { defineProvider } from '../container/types';
import { Module } from '../module/decorators';
import { attachModuleIdentity } from '../module/module-identity';
import type { DynamicModule } from '../module/types';
import { ScheduleRegistry } from './schedule.registry';
import { SCHEDULE_DISPATCH } from './schedule.tokens';
import type { ScheduleDispatchMode } from './schedule.types';

/**
 * Dedicated host for the dispatch policy. `forRoot({ dispatch })` contributes
 * `SCHEDULE_DISPATCH` through THIS class rather than through `ScheduleModule`
 * for two reasons:
 *
 *  1. The only consumers (the schedule-node executor, the Cloudflare adapter,
 *     Studio) live in OTHER modules, so the token must be GLOBAL — and a
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

// A signed policy keys by reference: a helper that builds
// `target: () => ({ path })` per call yields policies with one source but
// different captured targets, which no structural key tells apart.
const policyIds = new WeakMap<ScheduleDispatchMode, number>();
let nextPolicyId = 0;
function policyIdentity(dispatch: ScheduleDispatchMode): string {
  if (dispatch.kind === 'direct') return 'direct';
  let id = policyIds.get(dispatch);
  if (id === undefined) {
    id = ++nextPolicyId;
    policyIds.set(dispatch, id);
  }
  return `signed:${id}`;
}

/**
 * Zero-config module (Tier C): providers live on the `@Module` bag; the
 * `forRoot()` static is NestJS-parity sugar returning the bare dynamic module
 * (default key — repeated calls dedup).
 *
 * `forRoot({ dispatch })` OPTS IN to signed re-entry for scheduled jobs
 * (`ctx.run`): it contributes a GLOBAL `SCHEDULE_DISPATCH` policy that
 * `invokeScheduledJob` honors on every runtime (the schedule-node executor, the
 * Cloudflare adapter's cron triggers, Studio's run-now), so the target route runs
 * the full request pipeline, global guards included. With no options jobs are
 * called directly in-isolate. An application configures one policy: two
 * `forRoot` calls with different `dispatch` policies (a different kind, or two
 * different signed policy objects, even ones a helper builds from one source)
 * fail bootstrap, and importing the same policy object again deduplicates.
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
    // Key by policy identity: a different policy becomes a second owner of
    // SCHEDULE_DISPATCH instead of being deduplicated into the first policy.
    // Bootstrap resolves the policy once per owner, and that fails when there
    // is more than one: each signed policy object is its own policy, so two
    // conflict even when they differ only in a captured target, method or TTL.
    return attachModuleIdentity(
      {
        module: ScheduleDispatchHost,
        key: `dispatch:${policyIdentity(dispatch)}`,
        providers: [
          defineProvider(SCHEDULE_DISPATCH, {
            useFactory: (container: Container) => {
              const owners = container.getOwnerModuleIds(SCHEDULE_DISPATCH);
              if (owners.length > 1) {
                throw new Error(
                  `ScheduleModule.forRoot() is imported with different dispatch policies by ` +
                    `${owners.join(', ')}. An application configures scheduled dispatch once: ` +
                    `import ScheduleModule.forRoot({ dispatch }) once, in the root module.`,
                );
              }
              return dispatch;
            },
            inject: [Container],
          }),
        ],
        exports: [SCHEDULE_DISPATCH],
        global: true,
      },
      { dispatch },
    );
  }
}
