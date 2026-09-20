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
   * Register AuthGuard application-wide. Defaults to `true`; opt out only when
   * the application installs an equivalent global authentication guard itself.
   */
  isGlobal?: boolean;
  mountHandler?: boolean;
}

// Re-export the base User/Session shapes for ergonomic consumer typing.
// Use BetterAuthService<typeof auth> to retain plugin API and result types.
export type User = BAUser;
export type Session = BASession;
