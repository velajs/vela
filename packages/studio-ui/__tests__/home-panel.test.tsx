import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  capabilitiesReadOnly,
  FakeAdminTransport,
  fakeTable,
  makeErrorBody,
} from '@velajs/studio-fixtures';
import { Studio } from '../src/shell/studio-app';
import { AdminClientProvider } from '../src/data/context';

afterEach(cleanup);

function renderHome(transport: FakeAdminTransport): void {
  render(
    <AdminClientProvider transport={transport}>
      <Studio initialPath="/" />
    </AdminClientProvider>,
  );
}

describe('home panel', () => {
  it('renders the features grid and a reachable status', async () => {
    renderHome(new FakeAdminTransport(fakeTable()));
    await screen.findByRole('heading', { name: 'Overview' });
    expect(await screen.findByText('reachable')).toBeTruthy();
    expect(screen.getByText('Features')).toBeTruthy();
  });

  it('reports read-only when every write gate is closed', async () => {
    renderHome(new FakeAdminTransport(fakeTable({ 'studio.capabilities': capabilitiesReadOnly })));
    await screen.findByRole('heading', { name: 'Overview' });
    expect(await screen.findByText(/Read-only — every write gate is closed/)).toBeTruthy();
  });

  it('shows an unreachable status when capabilities fail', async () => {
    const transport = new FakeAdminTransport(fakeTable(), {
      errors: { 'studio.capabilities': makeErrorBody('STUDIO_TRANSPORT_ERROR', 0) },
    });
    renderHome(transport);
    expect(await screen.findByText('unreachable')).toBeTruthy();
  });
});
