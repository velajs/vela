import type { InvocationTarget } from '../dispatch/index';

export interface CronMetadata {
  expression: string;
  methodName: string;
}

export interface IntervalMetadata {
  ms: number;
  methodName: string;
}

/**
 * A fired scheduled job, as passed to a signed-dispatch `target`. Enough to
 * pick a route without exposing the instance/method reference.
 */
export interface ScheduleJobRef {
  kind: 'cron' | 'interval';
  /** The decorated method the job fires. */
  methodName: string;
  /** Cron expression (`kind: 'cron'`). */
  expression?: string;
  /** Interval period in ms (`kind: 'interval'`). */
  ms?: number;
}

/**
 * How a fired scheduled job reaches its logic.
 *
 * `direct` (default) calls the decorated method in-isolate, unchanged. `signed`
 * re-enters the app through a per-invocation SIGNED route (`ctx.run`) so the
 * logic runs the full request pipeline. Purely additive: `ScheduleModule
 * .forRoot()` with no options stays `direct`.
 */
export type ScheduleDispatchMode =
  | { kind: 'direct' }
  | {
      kind: 'signed';
      /** Maps a fired job to the route/path it re-enters. */
      target: (job: ScheduleJobRef) => InvocationTarget;
      /** HTTP method for the signed re-entry request (default `POST`). */
      method?: string;
      /** Signed-claim lifetime override (seconds). */
      ttlSeconds?: number;
    };
