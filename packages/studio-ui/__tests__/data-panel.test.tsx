import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeAdminTransport,
  fakeTable,
  makeErrorBody,
  userDescriptor,
} from '@velajs/studio-fixtures';
import { Studio } from '../src/shell/studio-app';
import { AdminClientProvider } from '../src/data/context';

afterEach(cleanup);

function renderData(
  initialPath: string,
  transport: FakeAdminTransport,
): { history: RouterHistory } {
  const history = createMemoryHistory({ initialEntries: [initialPath] });
  render(
    <AdminClientProvider transport={transport}>
      <Studio history={history} />
    </AdminClientProvider>,
  );
  return { history };
}

const gridRows = (): HTMLElement[] => screen.queryAllByTestId('data-grid-row');

describe('data panel', () => {
  it('renders rows for the model named in the URL', async () => {
    renderData('/data?model=user', new FakeAdminTransport(fakeTable()));
    expect(await screen.findByText('user000@example.com')).toBeTruthy();
  });

  it('renders the empty state when a query matches no rows', async () => {
    renderData('/data?model=user&q=zzzzz', new FakeAdminTransport(fakeTable()));
    expect(await screen.findByText('No rows match this query.')).toBeTruthy();
  });

  it('renders the degraded state when the data source is unconfigured', async () => {
    const transport = new FakeAdminTransport(fakeTable(), {
      errors: { 'data.listModels': makeErrorBody('FEATURE_UNCONFIGURED', 404) },
    });
    renderData('/data', transport);
    expect(await screen.findByText('Not configured')).toBeTruthy();
  });

  it('hydrates the grid from the URL sort param (the link is the query)', async () => {
    renderData('/data?model=user&sort=email:desc&perPage=100', new FakeAdminTransport(fakeTable()));
    await screen.findByText('user059@example.com');
    // Descending by email ⇒ the first rendered row is the highest email.
    await waitFor(() => expect(gridRows().length).toBeGreaterThan(0));
    expect(within(gridRows()[0]).getByText('user059@example.com')).toBeTruthy();
  });

  it('serializes a sort change back into the URL', async () => {
    const { history } = renderData('/data?model=user', new FakeAdminTransport(fakeTable()));
    const header = await screen.findByRole('button', { name: /email/ });
    fireEvent.click(header);
    await waitFor(() => expect(history.location.href).toContain('sort=email'));
  });

  it('toggles a filter when a facet chip is clicked', async () => {
    const { history } = renderData('/data?model=user', new FakeAdminTransport(fakeTable()));
    const facets = await screen.findByRole('group', { name: 'Facets' });
    const chip = await within(facets).findByRole('button', { name: /admin/ });
    fireEvent.click(chip);
    await waitFor(() => {
      const url = decodeURIComponent(history.location.href);
      expect(url).toContain('role');
      expect(url).toContain('admin');
    });
  });

  it('hides the search box when the model does not support search', async () => {
    const noSearch = {
      ...userDescriptor,
      supports: { ...userDescriptor.supports, search: false },
    };
    renderData(
      '/data?model=user',
      new FakeAdminTransport(fakeTable({ 'data.describeModel': () => noSearch })),
    );
    // The model header still renders (columns badge), but the search box does not.
    await screen.findByText(/columns/);
    expect(screen.queryByLabelText('Search rows')).toBeNull();
  });

  it('virtualizes: renders a subset of a large page', async () => {
    renderData('/data?model=user&perPage=100', new FakeAdminTransport(fakeTable()));
    await screen.findByText('user000@example.com');
    // 57 non-deleted user rows exist; the virtual window renders far fewer.
    await waitFor(() => expect(gridRows().length).toBeGreaterThan(0));
    expect(gridRows().length).toBeLessThan(57);
  });

  it('opens the row detail drawer via data.readRow', async () => {
    const transport = new FakeAdminTransport(fakeTable());
    renderData('/data?model=user', transport);
    await screen.findByText('user000@example.com');
    fireEvent.click(gridRows()[0]);
    const dialog = await screen.findByRole('dialog', { name: /Row/ });
    expect(await within(dialog).findByText('email')).toBeTruthy();
    expect(transport.calls.some((c) => c.op === 'data.readRow')).toBe(true);
  });
});
