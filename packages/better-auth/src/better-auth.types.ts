import type { Auth, Session as BASession, User as BAUser } from 'better-auth';

/** The runtime surface required by the integration; concrete instances retain their generics. */
export interface BetterAuthInstance {
  readonly api: {
    getSession(input: { headers: Headers }): Promise<unknown>;
  };
  readonly handler: (request: Request) => Promise<Response>;
  /** Used only by the real-session testing helper. */
  readonly $context?: Promise<
    Pick<Awaited<Auth['$context']>, 'internalAdapter' | 'authCookies' | 'secret'>
  >;
}

export interface BetterAuthModuleOptions<
  TAuth extends BetterAuthInstance = BetterAuthInstance,
> extends BetterAuthRuntimeOptions {
  auth: TAuth;
}

/** Provider configuration, separate from the lazily constructed auth instance. */
export interface BetterAuthRuntimeOptions {
  /** Stable namespace paired with user ids in authorization identities. */
  issuer?: string;
  basePath?: string;
  /**
   * `'global'` (default) installs AuthGuard as a global guard in the
   * `authenticate` phase, so it runs before tenant, authorization and feature
   * guards whatever the import order. Use `'none'` only when the application
   * installs an equivalent authentication guard itself.
   */
  guard?: 'global' | 'none';
  mountHandler?: boolean;
}

// Re-export the base User/Session shapes for ergonomic consumer typing.
// Use BetterAuthService<typeof auth> to retain plugin API and result types.
export type User = BAUser;
export type Session = BASession;
