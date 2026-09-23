import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilitiesDegraded, FakeAdminTransport, fakeTable } from '@velajs/studio-fixtures';
import { STUDIO_PROTOCOL_VERSION } from '@velajs/studio-protocol';
import { StudioApp } from '../src/shell/studio-app';
import { Studio } from '../src/shell/studio-app';
import { renderWithAdmin, studioFetch } from './helpers';

afterEach(() => {
  cleanup();
  try {
    sessionStorage.clear();
  } catch {
    // ignore
  }
});

/**
 * The sidebar nav, scoped. The real Overview panel also renders quick-link
 * anchors to every enabled domain, so a bare `getByRole('link', …)` is now
 * ambiguous — tab-navigation assertions must target the sidebar `<nav>`.
 */
async function sidebar(): Promise<ReturnType<typeof within>> {
  return within(await screen.findByRole('navigation', { name: 'Studio sections' }));
}

describe('StudioApp login gate', () => {
  it('boots a local connection without login or persisting its session token', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    render(
      <StudioApp
        baseUrl="http://host"
        connection={{
          protocolVersion: STUDIO_PROTOCOL_VERSION,
          adminBasePath: '/custom/admin',
          routerBasePath: '/',
          apiRequestPath: '/custom/admin/api-request',
          sessionToken: 'host-session',
        }}
        fetchImpl={studioFetch({ requests })}
        initialPath="/"
      />,
    );
    await sidebar();
    expect(screen.queryByLabelText('Admin token')).toBeNull();
    expect(sessionStorage.length).toBe(0);
    expect(requests.every((request) => request.url.startsWith('http://host/custom/admin/'))).toBe(
      true,
    );
    expect(
      requests.every(
        (request) =>
          new Headers(request.init?.headers).get('authorization') === 'Bearer host-session',
      ),
    ).toBe(true);
  });

  it('rejects an invalid token even when the unauthenticated health probe is enabled', async () => {
    render(
      <StudioApp
        baseUrl="http://host"
        initialPath="/"
        fetchImpl={async (input) => {
          if (String(input).endsWith('/health'))
            return Response.json({ enabled: true, protocolVersion: STUDIO_PROTOCOL_VERSION });
          return Response.json(
            {
              ok: false,
              op: 'studio.capabilities',
              status: 401,
              error: {
                code: 'STUDIO_UNAUTHORIZED',
                status: 401,
                title: 'Unauthorized',
                message: 'Invalid admin token',
              },
            },
            { status: 401 },
          );
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Admin token'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Invalid admin token');
    expect(sessionStorage.length).toBe(0);
    expect(screen.queryByRole('navigation', { name: 'Studio sections' })).toBeNull();
  });
  it('shows the login screen with no token, then flips to the shell after submit', async () => {
    render(<StudioApp baseUrl="http://host" fetchImpl={studioFetch()} initialPath="/" />);

    // Login is showing; no nav yet.
    expect(screen.getByLabelText('Admin token')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Routes' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Admin token'), { target: { value: 'secret-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    // Shell appears (nav + real landing panel).
    expect((await sidebar()).getByRole('link', { name: 'Routes' })).toBeTruthy();
    await screen.findByRole('heading', { name: 'Overview' });
    expect(screen.queryByLabelText('Admin token')).toBeNull();
  });

  it('routes RPCs to a custom adminBasePath while the shell still renders (no redirect loop)', async () => {
    // Regression: `adminBasePath` (server admin-mount prefix) and the router
    // basepath used to be conflated behind one `basePath` prop, so a non-default
    // admin prefix drove the memory router into a not-found → redirect loop.
    // They are now independent: a custom `adminBasePath` must reach the client
    // (RPC/health URLs) without touching the router, which stays at its default.
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    render(
      <StudioApp
        baseUrl="http://host"
        adminBasePath="/custom/admin"
        adminToken="secret-token"
        fetchImpl={studioFetch({ requests })}
        initialPath="/"
      />,
    );

    // Shell renders: nav + landing panel appear (proves no redirect loop).
    expect((await sidebar()).getByRole('link', { name: 'Routes' })).toBeTruthy();
    await screen.findByRole('heading', { name: 'Overview' });

    // RPCs went to the custom admin prefix — and never to the default one.
    await waitFor(() =>
      expect(requests.some((req) => req.url.includes('/custom/admin/rpc/'))).toBe(true),
    );
    expect(requests.every((req) => req.url.startsWith('http://host/custom/admin'))).toBe(true);
    expect(requests.some((req) => req.url.includes('/_vela/admin'))).toBe(false);
  });
});

describe('Studio shell (capability gating)', () => {
  it('hides a tab whose feature is positively false', async () => {
    const transport = new FakeAdminTransport(
      fakeTable({ 'studio.capabilities': capabilitiesDegraded }),
    );
    renderWithAdmin(<Studio initialPath="/" />, transport);

    await screen.findByRole('heading', { name: 'Overview' });
    const nav = await sidebar();
    // `transfer` stays visible (feature true); `timeTravel`/`data` are hidden.
    await waitFor(() => expect(nav.queryByRole('link', { name: 'Time Travel' })).toBeNull());
    expect(nav.queryByRole('link', { name: 'Data' })).toBeNull();
    expect(nav.queryByRole('link', { name: 'Transfer' })).not.toBeNull();
    expect(nav.queryByRole('link', { name: 'Routes' })).not.toBeNull();
  });

  it('redirects a deep-link to a hidden tab back home', async () => {
    const transport = new FakeAdminTransport(
      fakeTable({ 'studio.capabilities': capabilitiesDegraded }),
    );
    renderWithAdmin(<Studio initialPath="/timeTravel" />, transport);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Overview' })).toBeTruthy());
    expect(screen.queryByText('Panel: timeTravel')).toBeNull();
  });
});

describe('Studio shell (command palette + lazy panels)', () => {
  it('opens with ⌘K and fuzzy-filters the tab list', async () => {
    renderWithAdmin(<Studio initialPath="/" />, new FakeAdminTransport(fakeTable()));
    await screen.findByRole('heading', { name: 'Overview' });

    fireEvent.keyDown(window, { key: 'k', metaKey: true });

    const input = await screen.findByLabelText('Command palette search');
    fireEvent.change(input, { target: { value: 'route' } });

    const dialog = screen.getByRole('dialog', { name: 'Command palette' });
    expect(within(dialog).getByText('Routes')).toBeTruthy();
    expect(within(dialog).queryByText('Audit')).toBeNull();
  });

  it('renders a lazy panel stub when navigating to a tab', async () => {
    renderWithAdmin(<Studio initialPath="/" />, new FakeAdminTransport(fakeTable()));
    await screen.findByRole('heading', { name: 'Overview' });

    fireEvent.click((await sidebar()).getByRole('link', { name: 'Modules' }));

    expect(await screen.findByRole('heading', { name: 'Modules' })).toBeTruthy();
  });

  it('offers per-model quick jumps from data.listModels', async () => {
    renderWithAdmin(<Studio initialPath="/" />, new FakeAdminTransport(fakeTable()));
    await screen.findByRole('heading', { name: 'Overview' });

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = await screen.findByLabelText('Command palette search');
    fireEvent.change(input, { target: { value: 'user' } });

    const dialog = screen.getByRole('dialog', { name: 'Command palette' });
    // The `data model` hint is unique to the per-model jump entries.
    expect(await within(dialog).findByText('data model')).toBeTruthy();
  });
});
