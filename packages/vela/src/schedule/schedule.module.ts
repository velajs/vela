import { Container } from '../container/container';
import { defineProvider, InjectionToken } from '../container/types';
import { InternalDispatcher } from '../dispatch/internal-dispatcher';
import { Global, Module } from '../module/decorators';
import { defineModule } from '../module/define-module';
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
   * Resolved per application, including through forRootAsync factories.
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

const SCHEDULE_OPTIONS = new InjectionToken<ScheduleModuleOptions>('vela:schedule:options');

/** Every scheduler reads this application's one resolved policy. */
@Global()
@Module({
  providers: [
    defineProvider(SCHEDULE_DISPATCH, {
      inject: [Container],
      useFactory: async (container) => {
        const options = await Promise.all(
          container
            .getOwnerModuleIds(SCHEDULE_OPTIONS)
            .map((owner) => container.resolveAsync(SCHEDULE_OPTIONS, owner)),
        );
        const policies = options.flatMap((value) => (value.dispatch ? [value.dispatch] : []));
        const first = policies[0];
        if (
          policies.some(
            (policy) => policy !== first && !(policy.kind === 'direct' && first?.kind === 'direct'),
          )
        ) {
          throw new Error(
            'ScheduleModule is imported with different dispatch policies. Configure scheduled dispatch once per application.',
          );
        }
        const dispatch: ScheduleDispatchMode = first ? { ...first } : { kind: 'direct' };
        if (dispatch.kind !== 'direct' && dispatch.kind !== 'signed')
          throw new TypeError('Schedule dispatch kind must be direct or signed.');
        if (dispatch.kind === 'signed') {
          if (typeof dispatch.target !== 'function')
            throw new TypeError('Signed schedule dispatch requires a target function.');
          bindSignedScheduleDispatch(dispatch, runSignedScheduledJob(dispatch));
        }
        return dispatch;
      },
    }),
  ],
  exports: [SCHEDULE_DISPATCH],
})
class ScheduleDispatchHost {}

const { ConfigurableModuleClass } = defineModule<ScheduleModuleOptions>({
  name: 'Schedule',
  optionsToken: SCHEDULE_OPTIONS,
  setup: () => ({ imports: [ScheduleDispatchHost] }),
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
 * configurations cannot provide different policies, including when separately
 * keyed registrations resolve them asynchronously. Policies bind at bootstrap
 * in the application that owns their resolved options.
 */
@Module({ imports: [ScheduleRegistryModule], exports: [ScheduleRegistryModule] })
export class ScheduleModule extends ConfigurableModuleClass {}
