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
  /**
   * The better-auth instance, or a function that builds it. A function runs on
   * the first authentication (`BetterAuthService.auth`), so a `forRootAsync`
   * factory can return `{ auth: () => betterAuth({ ... }) }` from injected
   * bindings without constructing better-auth at bootstrap.
   */
  auth: TAuth | (() => TAuth);
}

/** Provider configuration, separate from the lazily constructed auth instance. */
export interface BetterAuthRuntimeOptions {
  /** Stable namespace paired with user ids in authorization identities. */
  issuer?: string;
  /** Mount path of the catch-all handler (default `/api/auth`). Structural. */
  basePath?: string;
  /**
   * Register AuthGuard application-wide. Defaults to `true`; opt out only when
   * the application installs an equivalent global authentication guard itself.
   * Structural.
   */
  globalGuard?: boolean;
  /** Mount the catch-all better-auth handler (default `true`). Structural. */
  mountHandler?: boolean;
}

/** The fields `forRootAsync` takes alongside its factory: they shape the module graph. */
export type BetterAuthStructuralOption = 'basePath' | 'globalGuard' | 'mountHandler';

// Re-export the base User/Session shapes for ergonomic consumer typing.
// Use BetterAuthService<typeof auth> to retain plugin API and result types.
export type User = BAUser;
export type Session = BASession;
