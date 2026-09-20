// Mechanics adapted from @stratal/testing (MIT, © Temitayo Fadojutimi):
// mint a real better-auth session via `$context.internalAdapter` and hand back
// a signed session-cookie header. Adapted to better-auth >=1.6: the session
// cookie is signed with the package's own `makeSignature` (better-auth/crypto)
// — the same primitive better-auth's built-in test cookie builder uses — so no
// endpoint-context shim or `setSessionCookie` mock is needed.
import { makeSignature } from 'better-auth/crypto';
import { BetterAuthService } from '../better-auth.service';

/**
 * The slice of `@velajs/testing`'s `TestingModule` this resolver depends on.
 * Declared structurally so `@velajs/better-auth/testing` carries NO runtime
 * (or type) dependency on `@velajs/testing` — a real `TestingModule` satisfies
 * it, and the resolver stays assignable to `@velajs/testing`'s `ActingAsResolver`.
 */
export interface TestModuleLike {
  get(token: typeof BetterAuthService): BetterAuthService;
}

/**
 * A test principal. Opaque `Record<string, unknown>` to stay compatible with
 * `@velajs/testing`'s `TestPrincipal`. Recognized fields:
 *
 * - `id`    — reuse the user with this id if it already exists.
 * - `email` — reuse the user with this email, else create one.
 * - `name`  — display name for a created user (defaults to the email).
 *
 * Any other fields are forwarded to `internalAdapter.createUser` (e.g. `role`)
 * when a new user is minted, so role-guarded routes can be exercised.
 */
export type ActingAsPrincipal = Record<string, unknown>;

/**
 * actingAs — a `@velajs/testing` auth resolver for better-auth.
 *
 * Resolves {@link BetterAuthService} from the module, mints a REAL better-auth
 * session for `principal` through `auth.$context.internalAdapter`, and returns
 * a `Headers` carrying a properly signed session cookie. Guarded routes
 * (`AuthGuard`) then accept requests carrying those headers because
 * `auth.api.getSession` validates the cookie against the same session store.
 *
 * The signature `(module, principal) => Promise<Headers>` is exactly
 * `@velajs/testing`'s `ActingAsResolver`, so it plugs straight in:
 *
 * @example
 * ```ts
 * import { actingAs } from '@velajs/better-auth/testing';
 *
 * // As the default resolver for the module:
 * module.setAuthResolver(actingAs);
 * await module.http.get('/me').actingAs({ email: 'ada@example.com' }).send();
 *
 * // Or passed per-request:
 * await module.http.get('/me').actingAs({ id: existingUserId }, actingAs).send();
 * ```
 */
export async function actingAs(
  module: TestModuleLike,
  principal: ActingAsPrincipal,
): Promise<Headers> {
  const auth = module.get(BetterAuthService).auth;
  const ctx = await auth.$context;
  if (!ctx)
    throw new Error('actingAs: the configured authentication provider has no Better Auth context');
  const internalAdapter = ctx.internalAdapter;

  const id = typeof principal.id === 'string' ? principal.id : undefined;
  const email = typeof principal.email === 'string' ? principal.email : undefined;
  const name = typeof principal.name === 'string' ? principal.name : undefined;

  // `findUserById`/`createUser` yield a bare user; `findUserByEmail` nests it
  // under `{ user, accounts }` — normalize to the id we need.
  let user: { id: string } | null = null;
  if (id) user = await internalAdapter.findUserById(id);
  if (!user && email) {
    const found = await internalAdapter.findUserByEmail(email);
    user = found?.user ?? null;
  }
  if (!user) {
    if (!email) {
      throw new Error(
        'actingAs: principal must carry an `email` (to create a user) or an ' +
          '`id` matching an existing user.',
      );
    }
    const { id: _id, email: _email, name: _name, ...extra } = principal;
    user = await internalAdapter.createUser(
      {
        ...extra,
        email,
        name: name ?? email,
        ...(id ? { id } : {}),
      },
      { method: 'admin' },
    );
  }

  const session = await internalAdapter.createSession(user.id, false, {
    ipAddress: '127.0.0.1',
    userAgent: 'vela-test',
  });

  const cookieName = ctx.authCookies.sessionToken.name;
  const signedToken = `${session.token}.${await makeSignature(session.token, ctx.secret)}`;

  const headers = new Headers();
  headers.set('Cookie', `${cookieName}=${signedToken}`);
  return headers;
}
