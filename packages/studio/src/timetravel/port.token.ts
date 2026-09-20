/**
 * The `TIME_TRAVEL_PORT` DI token. The {@link TimeTravelPort} interface is frozen
 * in `@velajs/studio-protocol` (the wire-shape source); the token lives here in
 * the server package (the protocol carries pure types, never DI identities).
 *
 * OPTIONAL injection: an app opts in by importing a module that binds this token
 * (the portable {@link import('./timetravel.module').StudioTimeTravelModule}, or
 * a CF-DO PITR module in M11). Unbound ⇒ `timeTravel.*` ops report
 * `TIMETRAVEL_UNAVAILABLE` (409) and `studio.capabilities.timeTravel` is `null`.
 */
import { InjectionToken } from '@velajs/vela';
import type { TimeTravelPort } from '@velajs/studio-protocol';

/** DI token an app binds to make a {@link TimeTravelPort} available to Studio. */
export const TIME_TRAVEL_PORT = new InjectionToken<TimeTravelPort>('TIME_TRAVEL_PORT');
