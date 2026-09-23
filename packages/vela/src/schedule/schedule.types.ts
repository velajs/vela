import type { Container } from '../container/container';
import type { InvocationTarget } from '../dispatch/index';
import type { CronOptions } from './cron-matcher';

export interface CronMetadata extends CronOptions {
  expression: string;
  methodName: string;
}

export interface IntervalMetadata {
  ms: number;
  methodName: string;
}

/**
 * The only argument a scheduled handler receives, identical on every runtime:
 * the Node executor, a Workers cron trigger and Studio's run-now. `expression`
 * is the cron string that fired (on Workers, the trigger's exact string),
 * `scheduledTime` is in Unix milliseconds, and `signal` aborts when the
 * application closes. Cancellation is cooperative; close awaits completion.
 */
export type ScheduleInvocation =
  | {
      readonly kind: 'cron';
      readonly expression: string;
      readonly scheduledTime: number;
      readonly signal: AbortSignal;
    }
  | {
      readonly kind: 'interval';
      readonly ms: number;
      readonly scheduledTime: number;
      readonly signal: AbortSignal;
    };

/**
 * Seeds request-scoped values into the scope of a scheduled job that fires
 * outside its native trigger (for example Studio's run-now), as a platform
 * trigger would. See `SCHEDULE_INVOCATION_SEED`.
 */
export type ScheduleInvocationSeed = (scope: Container, invocation: ScheduleInvocation) => void;

/** The invocation a `@Cron` job receives. */
export type CronInvocation = Extract<ScheduleInvocation, { kind: 'cron' }>;

/** The invocation an `@Interval` job receives. */
export type IntervalInvocation = Extract<ScheduleInvocation, { kind: 'interval' }>;

/**
 * A method decorator for scheduled jobs: the decorated method receives only
 * the invocation `I`, so a handler declaring another required parameter, or a
 * first parameter that is not the invocation, does not compile.
 */
export type ScheduleDecorator<I extends ScheduleInvocation> = <
  Handler extends (invocation: I) => unknown,
>(
  target: object,
  key: string | symbol,
  descriptor: TypedPropertyDescriptor<Handler>,
) => void;

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
