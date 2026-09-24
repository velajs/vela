import { Reflector } from './reflector';
import {
  isSkippableGuardPhase,
  SKIP_GUARD_PHASES_KEY,
  type SkippableGuardPhase,
} from './guard-phase';

/**
 * Marks an integration package's own controller, or one of its routes, whose
 * access the integration enforces itself: global guards in the listed phases
 * do not run for it. An authentication handler, for example, is outside
 * application-wide tenant admission and authorization
 * (`SkipGuardPhases(['tenant', 'authorize'])`), and a transport that
 * authorizes each operation is outside route authorization
 * (`SkipGuardPhases(['authorize'])`).
 *
 * Authentication and feature guards (throttling, flags) always run, and so do
 * the route's own `@UseGuards` guards. Applications mark their own routes with
 * each phase's marker instead (`@TenantIgnored()`, `@CedarPublic()`).
 */
export const SkipGuardPhases = Reflector.createDecorator<
  readonly SkippableGuardPhase[],
  readonly SkippableGuardPhase[]
>({
  key: SKIP_GUARD_PHASES_KEY,
  transform: (phases) => {
    for (const phase of phases) {
      if (!isSkippableGuardPhase(phase)) {
        throw new TypeError(
          `SkipGuardPhases accepts 'tenant' and 'authorize', not '${String(phase)}'`,
        );
      }
    }
    return Object.freeze([...phases]);
  },
});
