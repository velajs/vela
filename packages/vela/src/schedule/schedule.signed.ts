import type { Container } from '../container/container';
import type { ScheduleDispatchMode, ScheduleJobRef } from './schedule.types';

/** The dispatch policy under which fired jobs re-enter a signed route. */
export type SignedScheduleDispatch = Extract<ScheduleDispatchMode, { kind: 'signed' }>;

/**
 * @internal Re-enter one fired job's route under a signed policy, resolving
 * what it needs from the application container.
 */
export type SignedScheduleRunner = (
  container: Container,
  job: ScheduleJobRef,
  signal: AbortSignal,
) => Promise<void>;

const runners = new WeakMap<SignedScheduleDispatch, SignedScheduleRunner>();

/**
 * @internal Record how a signed policy re-enters its routes.
 * ScheduleModule binds its resolved signed policy during application bootstrap,
 * so the signing and dispatch code ships only with applications
 * that configure signed dispatch, not with every runtime that fires jobs.
 */
export function bindSignedScheduleDispatch(
  policy: SignedScheduleDispatch,
  runner: SignedScheduleRunner,
): void {
  runners.set(policy, runner);
}

/** @internal The runner `ScheduleModule.forRoot()` bound to a signed policy. */
export function getSignedScheduleRunner(
  policy: SignedScheduleDispatch,
): SignedScheduleRunner | undefined {
  return runners.get(policy);
}
