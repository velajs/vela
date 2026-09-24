/**
 * The auth-panel source port. Studio's `auth.*` ops are authored ONCE against
 * this interface — never against `@velajs/better-auth` directly — so the core
 * `.` entry stays free of the (heavy) better-auth dependency (the optional-peer
 * discipline, same as `STUDIO_MODEL_SOURCE`). The better-auth-backed
 * implementation lives in the `@velajs/studio/auth` subpath
 * ({@link import('./index').BetterAuthStudioSource}); it is the only module that
 * imports better-auth, and it is loaded only by apps that actually have it.
 *
 * Everything crossing the wire is a frozen `@velajs/studio-protocol` row type.
 */
import { InjectionToken } from '@velajs/vela';
import type {
  AuthOrgRow,
  AuthSessionRow,
  AuthUserDetail,
  AuthUserRow,
} from '@velajs/studio-protocol';

/**
 * Which better-auth capabilities this app actually wired. Both plugins are
 * OPTIONAL: with `admin` false the user/session/revoke ops report
 * `FEATURE_UNCONFIGURED`; with `organizations` false the `auth.organizations`
 * op reports it and the `authOrganizations` feature stays dark (independently
 * of `auth`).
 */
export interface StudioAuthCapabilities {
  /** better-auth `admin()` plugin present → users / sessions / revoke serviceable. */
  admin: boolean;
  /** better-auth `organization()` plugin present → organizations serviceable. */
  organizations: boolean;
}

/**
 * A bindable source for the auth panels. All shapes are the frozen
 * `@velajs/studio-protocol` wire types — never re-declared. Implementers MUST
 * degrade honestly: an op whose backing plugin is absent throws
 * `studioError('FEATURE_UNCONFIGURED')`.
 */
export interface StudioAuthSource {
  /** Which better-auth plugins are wired (drives feature negotiation + op guards). */
  capabilities(): StudioAuthCapabilities;
  /** A cursor page of users, optionally filtered by a search needle. */
  listUsers(query: { q?: string; cursor?: string }): Promise<{
    rows: AuthUserRow[];
    nextCursor?: string;
  }>;
  /** One user with their sessions + organizations. */
  userDetail(id: string): Promise<AuthUserDetail>;
  /** Active sessions, optionally scoped to one user. */
  listSessions(userId?: string): Promise<AuthSessionRow[]>;
  /** Revoke a single session by id (WRITE — `opsEditable`-gated by dispatch). */
  revokeSession(sessionId: string): Promise<void>;
  /** Every organization (better-auth `organization()` plugin). */
  listOrganizations(): Promise<AuthOrgRow[]>;
}

/**
 * DI token the `auth.*` ops resolve their source from. Bound by
 * `authPanel()` (the `@velajs/studio/auth` subpath). Unbound ⇒ the `auth`
 * (and `authOrganizations`) features read false and every `auth.*` op reports
 * `FEATURE_UNCONFIGURED`.
 */
export const STUDIO_AUTH_SOURCE = new InjectionToken<StudioAuthSource>('STUDIO_AUTH_SOURCE');
