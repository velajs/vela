import type { Container } from '../container/container';
import { InternalDispatcher } from '../dispatch/index';
import type { Entrypoint } from '../entrypoint/entrypoint.types';
import { resolveEntrypoint } from '../entrypoint/execution-context';
import { runInEntrypointScope } from '../entrypoint/execution-scope';
import { resolveErrorReporter } from '../exceptions/reporter';
import {
  scheduledJobComponents,
  scheduledJobGuardsMessage,
  scheduledJobName,
} from './schedule.diagnostics';
import { SCHEDULE_DISPATCH } from './schedule.tokens';
import type {
  CronMetadata,
  IntervalMetadata,
  ScheduleInvocation,
  ScheduleJobRef,
} from './schedule.types';

export interface InvokeScheduledJobOptions {
  /**
   * Seed request-scoped values into the job's invocation scope before the job
   * resolves, for example a runtime's native event token. Direct dispatch only:
   * a signed re-entry runs in the route's own request scope.
   */
  readonly seed?: (scope: Container) => void;
}

function jobRef(
  meta: CronMetadata | IntervalMetadata,
  invocation: ScheduleInvocation,
): ScheduleJobRef {
  if (invocation.kind === 'cron') {
    if (!('expression' in meta)) throw new TypeError('A cron invocation requires a cron job.');
    return { kind: 'cron', expression: invocation.expression, methodName: meta.methodName };
  }
  if (!('ms' in meta)) throw new TypeError('An interval invocation requires an interval job.');
  return { kind: 'interval', ms: invocation.ms, methodName: meta.methodName };
}

/**
 * Run one fired scheduled job. Every runtime dispatches through this primitive:
 * the Node executor's timers, the Cloudflare adapter's cron triggers and
 * Studio's run-now, so a job behaves the same wherever it fires.
 *
 * - **Direct** (default): the job is resolved by its owning module inside a
 *   fresh invocation scope (request-scoped and transient dependencies are built
 *   for this invocation and disposed after it and its managed work settle) and
 *   its method is called with only the {@link ScheduleInvocation}. No guards,
 *   interceptors or filters run, neither app-global nor declared on the class,
 *   method or module: a tick has no caller to authorize, as with NestJS `@Cron`.
 *   A job that declares `@UseGuards` on its class, method or module fails
 *   closed: it is refused, without being resolved, rather than run unguarded.
 * - **Signed**: with `ScheduleModule.forRoot({ dispatch: { kind: 'signed' } })`
 *   the job re-enters its route through `InternalDispatcher`, so that route runs
 *   the full request pipeline, including global guards.
 *
 * A failure is reported once on the `schedule` edge and rethrown for the caller
 * to settle (the Node executor keeps running; a platform trigger fails). An
 * abort with the invocation's own signal reason is cancellation, not a failure.
 */
export async function invokeScheduledJob(
  container: Container,
  entry: Entrypoint<CronMetadata | IntervalMetadata>,
  invocation: ScheduleInvocation,
  options: InvokeScheduledJobOptions = {},
): Promise<void> {
  const job = jobRef(entry.meta, invocation);
  const context = {
    edge: 'schedule' as const,
    source: scheduledJobName(entry.token, job.methodName),
  };
  const cancelled = (error: unknown) =>
    invocation.signal.aborted && error === invocation.signal.reason;
  // The handler's own failure (or cancellation), already observed in scope.
  let observed: { error: unknown } | undefined;
  try {
    const dispatch = container.has(SCHEDULE_DISPATCH)
      ? await container.resolveAsync(SCHEDULE_DISPATCH)
      : undefined;
    if (dispatch?.kind === 'signed') {
      if (!container.has(InternalDispatcher))
        throw new Error('Signed schedule dispatch requires InternalDispatcher.');
      const dispatcher = await container.resolveAsync(InternalDispatcher);
      await dispatcher.run(dispatch.target(job), {
        method: dispatch.method,
        ttlSeconds: dispatch.ttlSeconds,
        iss: `schedule:${job.methodName}`,
        signal: invocation.signal,
      });
      return;
    }
    if (scheduledJobComponents(container, entry).includes('@UseGuards')) {
      throw new Error(scheduledJobGuardsMessage(context.source));
    }
    await runInEntrypointScope(
      container,
      async (scope) => {
        try {
          options.seed?.(scope);
          const instance: unknown = await resolveEntrypoint(scope, entry);
          invocation.signal.throwIfAborted();
          if (typeof instance !== 'object' || instance === null)
            throw new TypeError('Schedule provider must resolve to an object.');
          const method: unknown = Reflect.get(instance, job.methodName);
          if (typeof method !== 'function')
            throw new TypeError(`Scheduled method ${job.methodName} is not callable.`);
          await Reflect.apply(method, instance, [invocation]);
        } catch (error) {
          // Report the handler failure while its scope is still open, before
          // managed completion work can add a second, separate failure.
          observed = { error };
          if (!cancelled(error)) resolveErrorReporter(scope).report(error, context);
          throw error;
        }
      },
      { signal: invocation.signal },
    );
  } catch (error) {
    if (cancelled(error)) return;
    if (observed?.error !== error) {
      // Completion runs after the handler; report only what was not observed.
      const completion =
        observed && error instanceof AggregateError && error.errors[0] === observed.error
          ? error.errors[1]
          : error;
      resolveErrorReporter(container).report(completion, context);
    }
    throw error;
  }
}
