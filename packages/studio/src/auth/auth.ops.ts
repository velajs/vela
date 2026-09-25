/**
 * The auth panel ops: `auth.users`, `auth.userDetail`, `auth.sessions`,
 * `auth.revokeSession` (write), `auth.organizations`. Authored against the
 * {@link STUDIO_AUTH_SOURCE} port — this provider knows nothing about
 * better-auth, so it lives on the core `.` entry (registered unconditionally,
 * stable wire surface) and degrades to `FEATURE_UNCONFIGURED` until the
 * `@velajs/studio/auth` subpath binds a source.
 *
 * Gating + audit are applied by the dispatch registry AROUND these handlers:
 * `auth.revokeSession` is `mode: write, gate: opsEditable` in `STUDIO_OP_META`,
 * so a read-only Studio 403s it before it reaches the handler.
 */
import { Inject, Injectable } from '@velajs/vela';
import type { Container } from '@velajs/vela/module-kit';
import { STUDIO_APPLICATION_CONTAINER } from '../tokens';
import type {
  AuthOrgRow,
  AuthSessionRow,
  AuthUserDetail,
  AuthUserRow,
  StudioOpReq,
} from '@velajs/studio-protocol';
import { AdminRpc } from '../rpc/admin-rpc.decorator';
import type { AdminOpContext } from '../studio.types';
import { studioError } from '../studio.errors';
import { STUDIO_AUTH_SOURCE } from './auth.port';
import type { StudioAuthSource } from './auth.port';

@Injectable()
export class StudioAuthOps {
  constructor(@Inject(STUDIO_APPLICATION_CONTAINER) private readonly container: Container) {}

  @AdminRpc({ op: 'auth.users' })
  async users(
    _ctx: AdminOpContext,
    args: StudioOpReq<'auth.users'>,
  ): Promise<{ rows: AuthUserRow[]; nextCursor?: string }> {
    const source = this.adminSource();
    return source.listUsers({
      ...(args?.q !== undefined ? { q: args.q } : {}),
      ...(args?.cursor !== undefined ? { cursor: args.cursor } : {}),
    });
  }

  @AdminRpc({ op: 'auth.userDetail' })
  async userDetail(
    _ctx: AdminOpContext,
    args: StudioOpReq<'auth.userDetail'>,
  ): Promise<AuthUserDetail> {
    return this.adminSource().userDetail(args.id);
  }

  @AdminRpc({ op: 'auth.sessions' })
  async sessions(
    _ctx: AdminOpContext,
    args: StudioOpReq<'auth.sessions'>,
  ): Promise<AuthSessionRow[]> {
    return this.adminSource().listSessions(args?.userId);
  }

  @AdminRpc({ op: 'auth.revokeSession' })
  async revokeSession(
    ctx: AdminOpContext,
    args: StudioOpReq<'auth.revokeSession'>,
  ): Promise<{ ok: true }> {
    await this.adminSource().revokeSession(args.sessionId);
    ctx.audit({ target: 'auth.session', summary: `revoked session ${args.sessionId}` });
    return { ok: true };
  }

  @AdminRpc({ op: 'auth.organizations' })
  async organizations(_ctx: AdminOpContext): Promise<AuthOrgRow[]> {
    const source = this.boundSource();
    if (!source.capabilities().organizations) {
      throw studioError(
        'FEATURE_UNCONFIGURED',
        'the better-auth organization() plugin is not configured',
      );
    }
    return source.listOrganizations();
  }

  /** The bound source, else `FEATURE_UNCONFIGURED` (no `@velajs/studio/auth` wired). */
  private boundSource(): StudioAuthSource {
    if (!this.container.has(STUDIO_AUTH_SOURCE)) throw studioError('FEATURE_UNCONFIGURED');
    return this.container.resolve(STUDIO_AUTH_SOURCE);
  }

  /** The bound source, asserted admin-capable, else `FEATURE_UNCONFIGURED`. */
  private adminSource(): StudioAuthSource {
    const source = this.boundSource();
    if (!source.capabilities().admin) {
      throw studioError('FEATURE_UNCONFIGURED', 'the better-auth admin() plugin is not configured');
    }
    return source;
  }
}
