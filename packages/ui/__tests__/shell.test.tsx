import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilitiesDegraded, FakeAdminTransport, fakeTable } from '@velajs/studio-fixtures';
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

describe('StudioApp login gate', () => {
  it('shows the login screen with no token, then flips to the shell after submit', async () => {
    render(<StudioApp baseUrl="http://host" fetchImpl={studioFetch()} initialPath="/" />);

    // Login is showing; no nav yet.
    expect(screen.getByLabelText('Admin token')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Routes' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Admin token'), { target: { value: 'secret-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    // Shell appears (nav + landing panel).
    expect(await screen.findByRole('link', { name: 'Routes' })).toBeTruthy();
    await screen.findByText('Panel: home');
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
    expect(await screen.findByRole('link', { name: 'Routes' })).toBeTruthy();
    await screen.findByText('Panel: home');

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

    await screen.findByText('Panel: home');
    // `transfer` stays visible (feature true); `timeTravel`/`data` are hidden.
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Time Travel' })).toBeNull());
    expect(screen.queryByRole('link', { name: 'Data' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Transfer' })).not.toBeNull();
    expect(screen.queryByRole('link', { name: 'Routes' })).not.toBeNull();
  });

  it('redirects a deep-link to a hidden tab back home', async () => {
    const transport = new FakeAdminTransport(
      fakeTable({ 'studio.capabilities': capabilitiesDegraded }),
    );
    renderWithAdmin(<Studio initialPath="/timeTravel" />, transport);

    await waitFor(() => expect(screen.getByText('Panel: home')).toBeTruthy());
    expect(screen.queryByText('Panel: timeTravel')).toBeNull();
  });
});

describe('Studio shell (command palette + lazy panels)', () => {
  it('opens with ⌘K and fuzzy-filters the tab list', async () => {
    renderWithAdmin(<Studio initialPath="/" />, new FakeAdminTransport(fakeTable()));
    await screen.findByText('Panel: home');

    fireEvent.keyDown(window, { key: 'k', metaKey: true });

    const input = await screen.findByLabelText('Command palette search');
    fireEvent.change(input, { target: { value: 'route' } });

    const dialog = screen.getByRole('dialog', { name: 'Command palette' });
    expect(within(dialog).getByText('Routes')).toBeTruthy();
    expect(within(dialog).queryByText('Audit')).toBeNull();
  });

  it('renders a lazy panel stub when navigating to a tab', async () => {
    renderWithAdmin(<Studio initialPath="/" />, new FakeAdminTransport(fakeTable()));
    await screen.findByText('Panel: home');

    fireEvent.click(screen.getByRole('link', { name: 'Modules' }));

    expect(await screen.findByText('Panel: modules')).toBeTruthy();
  });
});
