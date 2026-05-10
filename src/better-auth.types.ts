import type { Auth, Session as BASession, User as BAUser } from 'better-auth';

// Auth<O> is invariant on its Options generic — `betterAuth({secret: 'x'})`
// returns `Auth<{secret: string, ...}>` which is NOT assignable to
// `Auth<BetterAuthOptions>` (where `secret` is optional). Using `Auth<any>` lets
// any specialization flow through forRoot/forRootAsync without forcing
// consumers to widen-cast.
export type BetterAuthInstance = Auth<any>;

export interface BetterAuthModuleOptions {
  auth: BetterAuthInstance;
  basePath?: string;
  isGlobal?: boolean;
  defaultPolicy?: 'deny' | 'allow';
  mountHandler?: boolean;
}

// Re-export the base User/Session shapes for ergonomic consumer typing.
// Plugins/custom fields extend these — consumers casting to a richer shape
// when needed remains straightforward.
export type User = BAUser;
export type Session = BASession;
