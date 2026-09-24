import { Container } from '../container/container';
import { defineProvider } from '../container/types';
import { InternalDispatcher } from '../dispatch/internal-dispatcher';
import { Module } from '../module/decorators';
import { defineModule } from '../module/define-module';
import { attachModuleIdentity } from '../module/module-fingerprints';
import { referenceKey } from '../module/reference-key';
import type { DynamicModule } from '../module/types';
import { ScheduleRegistry } from './schedule.registry';
import {
  bindSignedScheduleDispatch,
  type SignedScheduleDispatch,
  type SignedScheduleRunner,
} from './schedule.signed';
import { SCHEDULE_DISPATCH } from './schedule.tokens';
import type { ScheduleDispatchMode } from './schedule.types';

/** Options for {@link ScheduleModule.forRoot}. */
export interface ScheduleModuleOptions {
  /**
   * Opt-in signed re-entry for fired jobs (default: jobs are called directly).
   * Structural: it decides whether the module contributes the global
   * `SCHEDULE_DISPATCH` policy.
   */
  dispatch?: ScheduleDispatchMode;
}

/**
 * The application's one `ScheduleRegistry`. Every `ScheduleModule` instance
 * and `ScheduleNodeModule` import this class, so there is a single registry
 * however the schedule modules are configured.
 *
 * Lazy: the @Cron/@Interval discovery pass runs when ScheduleRegistry is first
 * resolved (executor bootstrap, introspection, first dispatch).
 */
@Module({ lazy: true, providers: [ScheduleRegistry], exports: [ScheduleRegistry] })
export class ScheduleRegistryModule {}

/**
 * Dedicated host for the dispatch policy. The policy's consumers (the
 * schedule-node executor, the Cloudflare adapter, Studio) live in other
 * modules, so the token must be global, and a dynamic module's `global: true`
 * globalizes all its exports: a single-token host keeps the globalization
 * scoped to the policy.
 */
class ScheduleDispatchHost {}

/**
 * Re-enter a fired job's route under `policy` through the application's
 * `InternalDispatcher`, so the route runs the full request pipeline. Lives
 * with the module that contributes signed policies: `invokeScheduledJob` runs
 * it without importing the dispatcher and its signing code.
 */
function runSignedScheduledJob(policy: SignedScheduleDispatch): SignedScheduleRunner {
  return async (container, job, signal) => {
    const dispatcher = await container.resolveAsync(InternalDispatcher);
    await dispatcher.run(policy.target(job), {
      method: policy.method,
      ttlSeconds: policy.ttlSeconds,
      iss: `schedule:${job.methodName}`,
      signal,
    });
  };
}

/**
 * A direct policy is a value; a signed policy keys by reference: a helper that
 * builds `target: () => ({ path })` per call yields policies with one source
 * but different captured targets, which no structural key tells apart.
 */
function policyKey(dispatch: ScheduleDispatchMode | undefined): string {
  if (dispatch === undefined) return 'none';
  return referenceKey(dispatch.kind === 'direct' ? 'direct' : dispatch);
}

/**
 * Each policy gets its own owner of `SCHEDULE_DISPATCH`. Bootstrap resolves the
 * policy once per owner and fails when there is more than one: each signed
 * policy object is its own policy, so two conflict even when they differ only
 * in a captured target, method or TTL.
 */
function dispatchHost(dispatch: ScheduleDispatchMode): DynamicModule {
  return attachModuleIdentity(
    {
      module: ScheduleDispatchHost,
      key: `dispatch:${policyKey(dispatch)}`,
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

const { ConfigurableModuleClass } = defineModule<ScheduleModuleOptions, 'dispatch'>({
  name: 'Schedule',
  structural: ['dispatch'],
  key: (options) => policyKey(options.dispatch),
  setup: ({ options }) => {
    const { dispatch } = options;
    if (!dispatch) return {};
    if (dispatch.kind === 'signed') {
      bindSignedScheduleDispatch(dispatch, runSignedScheduledJob(dispatch));
    }
    return { imports: [dispatchHost(dispatch)] };
  },
});

/**
 * Registers the application's `@Cron`/`@Interval` jobs (`ScheduleRegistry`).
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
@Module({ imports: [ScheduleRegistryModule], exports: [ScheduleRegistryModule] })
export class ScheduleModule extends ConfigurableModuleClass {}
