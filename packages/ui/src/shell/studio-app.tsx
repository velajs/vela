/**
 * The two entry components:
 *  - {@link Studio}: the provider-inheriting embed — assumes an
 *    `<AdminClientProvider>` is already above it, and just mounts the routed
 *    shell (router + chrome).
 *  - {@link StudioApp}: the full app — owns token state (memory + sessionStorage),
 *    shows the login screen until a token health-probes clean, then wraps
 *    {@link Studio} in its own `<AdminClientProvider>`.
 */
import { useCallback, useMemo, useState } from 'react';
import { RouterProvider } from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';
import { AdminClient, AdminError } from '../client/admin-client';
import { AdminClientProvider } from '../data/context';
import { ShellChromeProvider } from './chrome';
import type { StudioTheme } from './chrome';
import { LoginScreen } from './login';
import { createStudioRouter } from './router';
import { readStoredToken, writeStoredToken } from './session-token';

export interface StudioProps {
  /**
   * Router basepath — the sub-path the SPA itself is mounted under in the
   * browser (fed straight to the router). This is NOT the server admin-mount
   * prefix; defaults to `'/'`.
   */
  routerBasePath?: string;
  history?: RouterHistory;
  initialPath?: string;
  theme?: StudioTheme;
  onSignOut?: () => void;
}

export function Studio({
  routerBasePath = '/',
  history,
  initialPath,
  theme,
  onSignOut,
}: StudioProps) {
  const router = useMemo(
    () => createStudioRouter({ routerBasePath, history, initialPath }),
    [routerBasePath, history, initialPath],
  );
  const chrome = useMemo(() => ({ theme: theme ?? 'dark', onSignOut }), [theme, onSignOut]);
  return (
    <ShellChromeProvider value={chrome}>
      <RouterProvider router={router} />
    </ShellChromeProvider>
  );
}

export interface StudioAppProps {
  /** Origin the admin surface is served from. Defaults to same-origin (`''`). */
  baseUrl?: string;
  /**
   * Server admin-mount prefix — where the Studio admin API is mounted on the
   * server. Fed only to the {@link AdminClient} (RPC/health URLs); defaults to
   * `STUDIO_DEFAULT_PATH`. Independent of {@link routerBasePath}.
   */
  adminBasePath?: string;
  /**
   * Router basepath — the sub-path this SPA is mounted under in the browser.
   * Fed only to the router; defaults to `'/'`. Independent of
   * {@link adminBasePath}.
   */
  routerBasePath?: string;
  /** Seed a token (skips the login screen when set). */
  adminToken?: string;
  theme?: StudioTheme;
  history?: RouterHistory;
  initialPath?: string;
  fetchImpl?: typeof fetch;
}

export function StudioApp(props: StudioAppProps) {
  const {
    baseUrl = '',
    adminBasePath,
    routerBasePath,
    adminToken,
    fetchImpl,
    theme,
    history,
    initialPath,
  } = props;
  const [token, setToken] = useState<string | undefined>(() => adminToken ?? readStoredToken());
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // The client always reflects the committed token. During a login attempt the
  // candidate token is pushed onto the current client via `setToken` for the
  // health probe, before it is committed to state (and a fresh client built).
  const client = useMemo(
    () => new AdminClient({ baseUrl, basePath: adminBasePath, adminToken: token, fetchImpl }),
    [baseUrl, adminBasePath, fetchImpl, token],
  );

  const handleSubmit = useCallback(
    async (candidate: string) => {
      setPending(true);
      setError(null);
      client.setToken(candidate);
      try {
        const health = await client.health();
        if (!health.enabled) {
          setError('Studio is disabled on this server.');
          return;
        }
        writeStoredToken(candidate);
        setToken(candidate);
      } catch (err) {
        setError(
          err instanceof AdminError ? err.body.message : 'Could not reach the Studio server.',
        );
      } finally {
        setPending(false);
      }
    },
    [client],
  );

  const handleSignOut = useCallback(() => {
    writeStoredToken(undefined);
    client.setToken(undefined);
    setToken(undefined);
  }, [client]);

  if (token === undefined || token === '') {
    return <LoginScreen onSubmit={handleSubmit} error={error} pending={pending} theme={theme} />;
  }

  return (
    <AdminClientProvider transport={client} client={client}>
      <Studio
        routerBasePath={routerBasePath}
        history={history}
        initialPath={initialPath}
        theme={theme}
        onSignOut={handleSignOut}
      />
    </AdminClientProvider>
  );
}
