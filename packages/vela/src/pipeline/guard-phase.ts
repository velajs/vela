/**
 * The deterministic order of global guards, whatever order modules register
 * them in: authentication publishes identity, tenant admission scopes it,
 * authorization checks it, then feature guards (throttling, flags) run. A
 * guard declares its phase with `static readonly phase`; undeclared guards run
 * in the `'feature'` phase. Guards keep registration order within a phase.
 *
 * A policy guard an integration installs (tenant admission, authorization)
 * also declares `static readonly skippable = true`, so the routes of another
 * integration that enforces the phase itself (`SkipGuardPhases`) skip it.
 * Guards without it run on every route; a subclass inherits it, and declares
 * `static readonly skippable = false` to opt out.
 */
export type GuardPhase = 'authenticate' | 'tenant' | 'authorize' | 'feature';

const GUARD_PHASES: readonly GuardPhase[] = ['authenticate', 'tenant', 'authorize', 'feature'];
/** The rank of a guard without a declared phase. */
export const FEATURE_PHASE_RANK = GUARD_PHASES.length - 1;

/** The phases an integration's own routes can leave to the integration. */
export type SkippableGuardPhase = Extract<GuardPhase, 'tenant' | 'authorize'>;

/** The metadata key `SkipGuardPhases` writes; read without loading the Reflector. */
export const SKIP_GUARD_PHASES_KEY = 'vela:skip-guard-phases';

export function isSkippableGuardPhase(value: unknown): value is SkippableGuardPhase {
  return value === 'tenant' || value === 'authorize';
}

// A component's declared field (a middleware's `priority`, a guard's `phase`):
// a class's static field, or an instance's own field or its class's static one.
export function declaredField(value: unknown, field: string): unknown {
  if (typeof value !== 'function' && (typeof value !== 'object' || value === null)) {
    return undefined;
  }
  const declared: unknown = Reflect.get(value, field);
  if (declared !== undefined || typeof value === 'function') return declared;
  const constructor: unknown = Reflect.get(value, 'constructor');
  return typeof constructor === 'function' ? declaredField(constructor, field) : undefined;
}

/** A guard class's or instance's phase rank, or `undefined` when it declares none. */
export function guardPhaseRank(value: unknown): number | undefined {
  const phase = declaredField(value, 'phase');
  if (phase === undefined) return undefined;
  const rank = GUARD_PHASES.findIndex((known) => known === phase);
  if (rank < 0) throw new Error(`Global guard declares an unknown guard phase '${String(phase)}'`);
  return rank;
}

/**
 * Constructed global guards in phase order, keeping registration order within
 * a phase. Transports sort after construction because a guard provided by a
 * factory declares its phase only on the instance it builds. `skip` drops the
 * guards of the phases an integration's route leaves to the integration, but
 * only guards that declare `skippable: true` (the policy guards integrations
 * install, and subclasses that do not redeclare it); the others always run.
 */
export function orderGuardsByPhase<T>(guards: readonly T[], skip?: ReadonlySet<GuardPhase>): T[] {
  return guards
    .map((guard, index) => ({ guard, index, rank: guardPhaseRank(guard) ?? FEATURE_PHASE_RANK }))
    .filter(
      ({ guard, rank }) =>
        !skip?.has(GUARD_PHASES[rank]!) || declaredField(guard, 'skippable') !== true,
    )
    .toSorted((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ guard }) => guard);
}
