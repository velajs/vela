import type { Auth, Session as BASession, User as BAUser } from 'better-auth';

// Auth<O> is invariant on its Options generic — `betterAuth({secret: 'x'})`
// returns `Auth<{secret: string, ...}>` which is NOT assignable to
// `Auth<BetterAuthOptions>` (where `secret` is optional). Using `Auth<any>` lets
// any specialization flow through forRoot/forRootAsync without forcing
// consumers to widen-cast.
export type BetterAuthInstance = Auth<any>;

export interface BetterAuthModuleOptions {
  auth: BetterAuthInstance;
  /** Stable namespace paired with user ids in authorization identities. */
  issuer?: string;
  basePath?: string;
  /**
   * Register AuthGuard application-wide. Defaults to `true`; opt out only when
   * the application installs an equivalent global authentication guard itself.
   */
  isGlobal?: boolean;
  /** @deprecated Authentication is deny-by-default. Only `'deny'` is accepted. */
  defaultPolicy?: 'deny';
  mountHandler?: boolean;
}

// Re-export the base User/Session shapes for ergonomic consumer typing.
// Plugins/custom fields extend these — consumers casting to a richer shape
// when needed remains straightforward.
export type User = BAUser;
export type Session = BASession;
