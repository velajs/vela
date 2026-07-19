/**
 * `@velajs/studio/auth` — the OPTIONAL better-auth binding for the auth panels.
 *
 * This subpath is the ONLY module in the package that imports
 * `@velajs/better-auth` (and transitively `better-auth`): the core `.` entry
 * never does (the auth ops are authored against {@link STUDIO_AUTH_SOURCE}), so
 * apps without better-auth still mount `StudioModule` and just report the `auth`
 * feature false. An app WITH better-auth additionally imports
 * `StudioAuthModule`, which binds a {@link BetterAuthStudioSource} to the core
 * `STUDIO_AUTH_SOURCE` token.
 *
 * The source reaches better-auth's server API through the PUBLIC
 * `BetterAuthService.api` accessor. Because `BetterAuthInstance = Auth<any>`,
 * the admin/organization endpoint set is not statically known, so the API is
 * read STRUCTURALLY (probe `typeof api.<method> === 'function'`) — mirroring the
 * crud subpath's structural Zod introspection. Method presence IS the
 * capability signal: no `admin()` plugin ⇒ no `listUsers` ⇒ `admin: false`
 * (users/sessions/revoke degrade to `FEATURE_UNCONFIGURED`); no
 * `organization()` plugin ⇒ no `listOrganizations` ⇒ `organizations: false`.
 *
 * Wire-shape mapping honors exactly the fields the M1 review verified against
 * better-auth's `User`/`Session`/`Organization`. Row VALUES are mapped
 * defensively (better-auth returns `Date`s server-side; a JSON hop would stringify
 * them — `toEpoch` accepts both). NOTE (documented degradation): the better-auth
 * server API is called in its trusted server context (no forwarded session); the
 * per-user organization membership list is not enumerated server-side without the
 * member API, so `userDetail.organizations` is `[]`. Studio's own master-token
 * boundary is the authorization gate for these reads.
 */
import { Container, Inject, defineModule } from '@velajs/vela';
import { BetterAuthService } from '@velajs/better-auth';
import type {
  AuthOrgRow,
  AuthSessionRow,
  AuthUserDetail,
  AuthUserRow,
} from '@velajs/studio-protocol';
import { studioNotFound } from '../studio.errors';
import { STUDIO_AUTH_SOURCE } from './auth.port';
import type { StudioAuthCapabilities, StudioAuthSource } from './auth.port';

export const STUDIO_AUTH_MODULE_ID = 'studio.auth';

export { STUDIO_AUTH_SOURCE } from './auth.port';
export type { StudioAuthCapabilities, StudioAuthSource } from './auth.port';

/** Rows-per-page pulled from better-auth's offset-paginated admin `listUsers`. */
const USERS_PAGE_SIZE = 50;

/** One better-auth server-API method as reached structurally off `service.api`. */
type ApiFn = (input?: unknown) => Promise<unknown>;

/** Read a method off the (structurally-typed) better-auth `api`, or `undefined`. */
function apiFn(api: unknown, name: string): ApiFn | undefined {
  if (api === null || typeof api !== 'object') return undefined;
  const value = (api as Record<string, unknown>)[name];
  return typeof value === 'function' ? (value as ApiFn) : undefined;
}

/** A record view of an unknown value, or `undefined`. */
function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Epoch ms from a `Date` (server-side better-auth) or an ISO string / number (post-JSON). */
function toEpoch(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? 0 : ms;
  }
  return 0;
}

/** Pull an array out of `result` directly or off a named container key (`{ users: [...] }`). */
function arrayFrom(result: unknown, key: string): unknown[] {
  if (Array.isArray(result)) return result;
  const container = rec(result);
  const nested = container?.[key];
  return Array.isArray(nested) ? nested : [];
}

function toUserRow(value: unknown): AuthUserRow {
  const u = rec(value) ?? {};
  return {
    id: str(u.id) ?? '',
    email: str(u.email) ?? '',
    emailVerified: u.emailVerified === true,
    createdAt: toEpoch(u.createdAt),
    ...(str(u.name) !== undefined ? { name: str(u.name)! } : {}),
    ...(str(u.image) !== undefined ? { image: str(u.image)! } : {}),
    ...(str(u.role) !== undefined ? { role: str(u.role)! } : {}),
    ...(typeof u.banned === 'boolean' ? { banned: u.banned } : {}),
  };
}

function toSessionRow(value: unknown): AuthSessionRow {
  const s = rec(value) ?? {};
  return {
    id: str(s.id) ?? '',
    userId: str(s.userId) ?? '',
    createdAt: toEpoch(s.createdAt),
    expiresAt: toEpoch(s.expiresAt),
    ...(str(s.ipAddress) !== undefined ? { ipAddress: str(s.ipAddress)! } : {}),
    ...(str(s.userAgent) !== undefined ? { userAgent: str(s.userAgent)! } : {}),
  };
}

function toOrgRow(value: unknown): AuthOrgRow {
  const o = rec(value) ?? {};
  return {
    id: str(o.id) ?? '',
    name: str(o.name) ?? '',
    createdAt: toEpoch(o.createdAt),
    ...(str(o.slug) !== undefined ? { slug: str(o.slug)! } : {}),
    ...(typeof o.memberCount === 'number' ? { memberCount: o.memberCount } : {}),
  };
}

/**
 * A {@link StudioAuthSource} over `@velajs/better-auth`'s server API. Reaches
 * the admin/organization endpoints structurally (see the file header); every
 * call runs in better-auth's trusted server context.
 */
export class BetterAuthStudioSource implements StudioAuthSource {
  constructor(private readonly service: BetterAuthService) {}

  /** better-auth's server API, or `undefined` when construction throws (misconfigured). */
  private get api(): unknown {
    try {
      return this.service.api;
    } catch {
      return undefined;
    }
  }

  capabilities(): StudioAuthCapabilities {
    const api = this.api;
    return {
      admin: apiFn(api, 'listUsers') !== undefined,
      organizations: apiFn(api, 'listOrganizations') !== undefined,
    };
  }

  async listUsers(query: { q?: string; cursor?: string }): Promise<{
    rows: AuthUserRow[];
    nextCursor?: string;
  }> {
    const listUsers = apiFn(this.api, 'listUsers');
    if (listUsers === undefined) return { rows: [] };
    const offset = query.cursor !== undefined ? Number.parseInt(query.cursor, 10) : 0;
    const start = Number.isNaN(offset) ? 0 : Math.max(0, offset);
    const result = await listUsers({
      query: {
        limit: USERS_PAGE_SIZE,
        offset: start,
        ...(query.q !== undefined ? { searchValue: query.q, searchField: 'email' } : {}),
      },
    });
    const rows = arrayFrom(result, 'users').map(toUserRow);
    // Offset cursor: another page exists iff this one filled — honest for an
    // offset-paginated admin API with no server-provided cursor.
    return rows.length < USERS_PAGE_SIZE
      ? { rows }
      : { rows, nextCursor: String(start + USERS_PAGE_SIZE) };
  }

  async userDetail(id: string): Promise<AuthUserDetail> {
    const page = await this.listUsers({});
    const user = page.rows.find((row) => row.id === id);
    if (user === undefined) throw studioNotFound(`user '${id}' not found`);
    return { user, sessions: await this.listSessions(id), organizations: [] };
  }

  async listSessions(userId?: string): Promise<AuthSessionRow[]> {
    // better-auth's admin session listing is per-user (`listUserSessions`); there
    // is no global-session enumeration endpoint, so an unscoped call returns [].
    if (userId === undefined) return [];
    const listUserSessions = apiFn(this.api, 'listUserSessions');
    if (listUserSessions === undefined) return [];
    const result = await listUserSessions({ body: { userId } });
    return arrayFrom(result, 'sessions').map(toSessionRow);
  }

  async revokeSession(sessionId: string): Promise<void> {
    const revoke = apiFn(this.api, 'revokeUserSession') ?? apiFn(this.api, 'revokeSession');
    if (revoke === undefined) return;
    await revoke({ body: { sessionToken: sessionId, token: sessionId } });
  }

  async listOrganizations(): Promise<AuthOrgRow[]> {
    const listOrganizations = apiFn(this.api, 'listOrganizations');
    if (listOrganizations === undefined) return [];
    const result = await listOrganizations({});
    return arrayFrom(result, 'organizations').map(toOrgRow);
  }
}

/** Options for {@link StudioAuthModule}. Reserved for future auth-panel wiring. */
export type StudioAuthModuleOptions = Record<string, never>;

const { ConfigurableModuleClass } = defineModule<StudioAuthModuleOptions>({
  name: 'StudioAuth',
  setup: () => ({
    providers: [
      {
        provide: STUDIO_AUTH_SOURCE,
        useFactory: (container: Container) =>
          new BetterAuthStudioSource(container.resolve(BetterAuthService)),
        inject: [Container],
      },
    ],
    exports: [STUDIO_AUTH_SOURCE],
  }),
});

/**
 * Binds {@link BetterAuthStudioSource} to `STUDIO_AUTH_SOURCE`. Import it with
 * `StudioAuthModule.forRoot({})` ALONGSIDE `StudioModule` (and `BetterAuthModule`)
 * in apps that use better-auth — this is the seam that lights the `auth` feature.
 */
export class StudioAuthModule extends ConfigurableModuleClass {}
