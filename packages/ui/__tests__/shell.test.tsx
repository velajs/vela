import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilitiesDegraded, FakeAdminTransport, fakeTable } from '../../fixtures/src/index';
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
