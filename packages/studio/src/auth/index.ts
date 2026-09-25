import { defineProvider } from '@velajs/vela';
import { defineStudioPlugin, type StudioPlugin } from '../plugin';
/**
 * `@velajs/studio/auth` — the OPTIONAL better-auth binding for the auth panels.
 *
 * This subpath is the ONLY module in the package that imports
 * `@velajs/better-auth` (and transitively `better-auth`): the core `.` entry
 * never does (the auth ops are authored against {@link STUDIO_AUTH_SOURCE}), so
 * apps without better-auth still mount `StudioModule` and just report the `auth`
 * feature false. An app WITH better-auth adds `authPanel()` to
 * `StudioModule.forRoot({ plugins })`, which binds a
 * {@link BetterAuthStudioSource} to the core `STUDIO_AUTH_SOURCE` token.
 *
 * TRUSTED-SERVER READ PATH (why we DON'T call `service.api`). better-auth's
 * admin/organization HTTP endpoints (`api.listUsers`, `api.listUserSessions`,
 * `api.revokeUserSession`, `api.listOrganizations`) run `adminMiddleware` /
 * `getSessionFromCtx` and THROW `APIError UNAUTHORIZED` / `YOU_ARE_NOT_ALLOWED`
 * unless a forwarded admin session is present (`listOrganizations` dereferences
 * `ctx.context.session.user.id` and throws even harder). Studio calls them from
 * a trusted server context with NO session, so that path is a guaranteed throw.
 * Instead this source reads better-auth's DATA layer — `auth.$context` →
 * `{ internalAdapter, adapter }` — the same trusted-server surface
 * `@velajs/better-auth/testing`'s `actingAs` uses. `internalAdapter.listUsers` /
 * `listSessions` / `findUserById` and the raw `adapter.findMany` / `adapter.delete`
 * enforce NO user-level authz — legitimate here because Studio is already
 * master-token-gated, so it deliberately bypasses better-auth's admin authz.
 *
 * The context surface is not statically known (`BetterAuthInstance = Auth<any>`),
 * so methods are reached STRUCTURALLY (`typeof x.<method> === 'function'`) and
 * EVERY better-auth call is wrapped by {@link BetterAuthStudioSource.trusted}: a
 * thrown better-auth error, an unreachable `$context`, or a missing model maps to
 * a clean `FEATURE_UNCONFIGURED` — never a raw 500.
 *
 * Capability signal: the `admin` / `organizations` sub-features gate on the
 * PLUGIN being wired (`auth.options.plugins` carries `{ id: 'admin' }` /
 * `{ id: 'organization' }`), read synchronously off the instance options. The
 * organization models only exist in the schema when the `organization()` plugin
 * is registered (a raw `adapter.findMany({ model: 'organization' })` throws
 * otherwise), so gating `authOrganizations` on plugin presence is mandatory.
 *
 * Wire-shape mapping honors exactly the fields the M1 review verified against
 * better-auth's `User`/`Session`/`Organization`. Row VALUES are mapped
 * defensively (better-auth returns `Date`s server-side; a JSON hop would stringify
 * them — `toEpoch` accepts both). NOTE (documented degradation): the per-user
 * organization membership list is not enumerated server-side here, so
 * `userDetail.organizations` is `[]`.
 */
import { Container } from '@velajs/vela/module-kit';
import { BetterAuthService } from '@velajs/better-auth';
import { isVelaError } from '@velajs/errors';
import type { VelaError } from '@velajs/errors';
import type {
  AuthOrgRow,
  AuthSessionRow,
  AuthUserDetail,
  AuthUserRow,
} from '@velajs/studio-protocol';
import { studioError, studioNotFound } from '../studio.errors';
import { STUDIO_AUTH_SOURCE } from './auth.port';
import type { StudioAuthCapabilities, StudioAuthSource } from './auth.port';

export { STUDIO_AUTH_SOURCE } from './auth.port';
export type { StudioAuthCapabilities, StudioAuthSource } from './auth.port';

/** Rows-per-page pulled from better-auth's offset-paginated `internalAdapter.listUsers`. */
const USERS_PAGE_SIZE = 50;

/** A better-auth data-layer method reached structurally (positional OR single-object arg). */
type TrustedFn = (...args: unknown[]) => Promise<unknown>;

/** Read a callable method off an unknown data-layer object, or `undefined`. */
function method(holder: unknown, name: string): TrustedFn | undefined {
  const obj = rec(holder);
  const value = obj?.[name];
  return typeof value === 'function' ? (value as TrustedFn) : undefined;
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

/** better-auth's trusted server context — the DATA layer, not the authz HTTP plugin. */
interface TrustedAuthContext {
  /** `createInternalAdapter(...)`: `listUsers` / `listSessions` / `findUserById` / `deleteSession`. */
  readonly internalAdapter: unknown;
  /** The raw `DBAdapter`: `findMany` / `findOne` / `delete` / `count` by model, no middleware. */
  readonly adapter: unknown;
}

/**
 * A {@link StudioAuthSource} over `@velajs/better-auth`'s TRUSTED data layer
 * (`auth.$context` → `{ internalAdapter, adapter }`), NOT its authz-enforcing
 * HTTP admin/organization endpoints (see the file header for why). Every
 * better-auth call is wrapped by {@link BetterAuthStudioSource.trusted} so a
 * thrown better-auth error can never surface as a raw 500.
 */
export class BetterAuthStudioSource implements StudioAuthSource {
  constructor(private readonly service: BetterAuthService) {}

  capabilities(): StudioAuthCapabilities {
    const plugins = this.pluginIds();
    return { admin: plugins.has('admin'), organizations: plugins.has('organization') };
  }

  /**
   * The better-auth plugin ids, read SYNCHRONOUSLY off the instance options
   * (`capabilities()` is a sync port method — it cannot await `$context`).
   * Unreadable options ⇒ empty set ⇒ both capabilities false (features dark).
   */
  private pluginIds(): Set<string> {
    try {
      const plugins = rec(rec(this.service.auth)?.options)?.plugins;
      if (!Array.isArray(plugins)) return new Set();
      const ids = new Set<string>();
      for (const plugin of plugins) {
        const id = str(rec(plugin)?.id);
        if (id !== undefined) ids.add(id);
      }
      return ids;
    } catch {
      return new Set();
    }
  }

  async listUsers(query: { q?: string; cursor?: string }): Promise<{
    rows: AuthUserRow[];
    nextCursor?: string;
  }> {
    return this.trusted(async ({ internalAdapter }) => {
      const listUsers = method(internalAdapter, 'listUsers');
      if (listUsers === undefined) return { rows: [] };
      const parsed = query.cursor !== undefined ? Number.parseInt(query.cursor, 10) : 0;
      const start = Number.isNaN(parsed) ? 0 : Math.max(0, parsed);
      // `internalAdapter.listUsers(limit, offset, sortBy?, where?)`; search maps to
      // a `contains` filter on email (what better-auth's admin search uses).
      const where =
        query.q !== undefined
          ? [{ field: 'email', operator: 'contains', value: query.q }]
          : undefined;
      const result = await listUsers(USERS_PAGE_SIZE, start, undefined, where);
      const rows = arrayFrom(result, 'users').map(toUserRow);
      // Offset cursor: another page exists iff this one filled — honest for an
      // offset-paginated read with no server-provided cursor.
      return rows.length < USERS_PAGE_SIZE
        ? { rows }
        : { rows, nextCursor: String(start + USERS_PAGE_SIZE) };
    });
  }

  async userDetail(id: string): Promise<AuthUserDetail> {
    return this.trusted(async (ctx) => {
      // Direct lookup by id (NOT limited to the first page of `listUsers`).
      const findUserById = method(ctx.internalAdapter, 'findUserById');
      const raw = findUserById !== undefined ? await findUserById(id) : null;
      if (raw === null || raw === undefined) throw studioNotFound(`user '${id}' not found`);
      return {
        user: toUserRow(raw),
        sessions: await this.sessionsFor(ctx, id),
        organizations: [],
      };
    });
  }

  async listSessions(userId?: string): Promise<AuthSessionRow[]> {
    // better-auth's session store lists per-user (`internalAdapter.listSessions`);
    // there is no global-session enumeration, so an unscoped call returns [].
    if (userId === undefined) return [];
    return this.trusted((ctx) => this.sessionsFor(ctx, userId));
  }

  /** Sessions for one user off the already-resolved trusted context. */
  private async sessionsFor(ctx: TrustedAuthContext, userId: string): Promise<AuthSessionRow[]> {
    const listSessions = method(ctx.internalAdapter, 'listSessions');
    if (listSessions === undefined) return [];
    const result = await listSessions(userId);
    return arrayFrom(result, 'sessions').map(toSessionRow);
  }

  async revokeSession(sessionId: string): Promise<void> {
    return this.trusted(async ({ adapter, internalAdapter }) => {
      // Studio's `AuthSessionRow.id` maps to better-auth's session `id`, so revoke
      // by deleting that row through the raw adapter (no admin middleware). Fall
      // back to the internal adapter's token-keyed `deleteSession` if unavailable.
      const del = method(adapter, 'delete');
      if (del !== undefined) {
        await del({ model: 'session', where: [{ field: 'id', value: sessionId }] });
        return;
      }
      const deleteSession = method(internalAdapter, 'deleteSession');
      if (deleteSession !== undefined) await deleteSession(sessionId);
    });
  }

  async listOrganizations(): Promise<AuthOrgRow[]> {
    return this.trusted(async ({ adapter }) => {
      // The `organization` model exists only with the `organization()` plugin
      // (the op is capability-gated upstream); a raw `findMany` reads it directly.
      const findMany = method(adapter, 'findMany');
      if (findMany === undefined) return [];
      const result = await findMany({ model: 'organization' });
      return (Array.isArray(result) ? result : []).map(toOrgRow);
    });
  }

  /**
   * Resolve better-auth's trusted server context and run `use` against it,
   * translating ANY better-auth failure — a thrown `APIError`, an unreachable
   * `$context`, a missing model — into a clean `FEATURE_UNCONFIGURED` rather than
   * a raw 500. Studio errors we raise ourselves (e.g. `studioNotFound` for a
   * missing user) are branded `VelaError`s and pass straight through.
   */
  private async trusted<T>(use: (ctx: TrustedAuthContext) => Promise<T>): Promise<T> {
    let ctx: TrustedAuthContext;
    try {
      const resolved = rec(await this.service.auth.$context) ?? {};
      ctx = { internalAdapter: resolved.internalAdapter, adapter: resolved.adapter };
    } catch {
      throw this.unconfigured();
    }
    try {
      return await use(ctx);
    } catch (error) {
      if (isVelaError(error)) throw error;
      throw this.unconfigured();
    }
  }

  private unconfigured(): VelaError {
    return studioError(
      'FEATURE_UNCONFIGURED',
      "better-auth's trusted admin data layer is unavailable — verify the " +
        'admin()/organization() plugins and the database adapter are configured',
    );
  }
}

/**
 * The auth panel: binds {@link BetterAuthStudioSource} to `STUDIO_AUTH_SOURCE`,
 * lighting the `auth` feature in apps with `BetterAuthModule`:
 * `StudioModule.forRoot({ plugins: [authPanel()] })`.
 */
export function authPanel(): StudioPlugin {
  return defineStudioPlugin({
    name: 'auth',
    providers: [
      defineProvider(STUDIO_AUTH_SOURCE, {
        useFactory: (container: Container) =>
          new BetterAuthStudioSource(container.resolve(BetterAuthService)),
        inject: [Container],
      }),
    ],
  });
}
