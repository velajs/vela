import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import { afterEach, describe, expect, it } from 'vitest';
import type { DeleteRowsRequest, WriteRowRequest } from '@velajs/studio-protocol';
import { FakeAdminTransport, capabilitiesReadOnly, fakeTable } from '@velajs/studio-fixtures';
import { Studio } from '../src/shell/studio-app';
import { AdminClientProvider } from '../src/data/context';

afterEach(cleanup);

function renderData(initialPath: string, transport: FakeAdminTransport): void {
  const history = createMemoryHistory({ initialEntries: [initialPath] });
  render(
    <AdminClientProvider transport={transport}>
      <Studio history={history} />
    </AdminClientProvider>,
  );
}

const callsFor = (t: FakeAdminTransport, op: string) => t.calls.filter((c) => c.op === op);
const gridRows = (): HTMLElement[] => screen.queryAllByTestId('data-grid-row');

describe('data panel — write affordances', () => {
  it('creates a row: form → writeRow with no id → list invalidated', async () => {
    const transport = new FakeAdminTransport(fakeTable());
    renderData('/data?model=user', transport);
    await screen.findByText('user000@example.com');
    const listBefore = callsFor(transport, 'data.listRows').length;

    fireEvent.click(screen.getByRole('button', { name: 'New row' }));
    fireEvent.change(await screen.findByLabelText('email'), {
      target: { value: 'zed@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create row' }));

    await waitFor(() => expect(callsFor(transport, 'data.writeRow')).toHaveLength(1));
    const args = callsFor(transport, 'data.writeRow')[0].args as WriteRowRequest;
    expect(args.id).toBeUndefined();
    expect(args.patch.email).toBe('zed@example.com');
    // Success invalidates the row list → a refetch beyond the initial load.
    await waitFor(() =>
      expect(callsFor(transport, 'data.listRows').length).toBeGreaterThan(listBefore),
    );
  });

  it('edits a row: staged patch → writeRow with id + only the changed field', async () => {
    const transport = new FakeAdminTransport(fakeTable());
    renderData('/data?model=user', transport);
    await screen.findByText('user000@example.com');
    fireEvent.click(gridRows()[0]);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const nameInput = await screen.findByLabelText('name');
    fireEvent.change(nameInput, { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(callsFor(transport, 'data.writeRow')).toHaveLength(1));
    const args = callsFor(transport, 'data.writeRow')[0].args as WriteRowRequest;
    expect(args.id).toBe('u_000');
    expect(Object.keys(args.patch)).toEqual(['name']);
    expect(args.patch.name).toBe('Renamed');
  });

  it('deletes through the 428 dialog: challenge summary → confirm → retry with token', async () => {
    const transport = new FakeAdminTransport(fakeTable());
    renderData('/data?model=user', transport);
    await screen.findByText('user000@example.com');

    fireEvent.change(screen.getByLabelText('Delete mode'), { target: { value: 'hard' } });
    fireEvent.click(screen.getByLabelText('Select row u_000'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete (1)' }));

    // The first attempt is challenged: the server summary lands in the dialog.
    expect(await screen.findByText('hard-delete 1 rows from user')).toBeTruthy();
    expect(callsFor(transport, 'data.deleteRows')).toHaveLength(1);

    const dialog = screen.getByRole('dialog', { name: 'Delete rows' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(callsFor(transport, 'data.deleteRows')).toHaveLength(2));
    const retry = callsFor(transport, 'data.deleteRows')[1].args as DeleteRowsRequest;
    expect(retry.confirmToken).not.toBe('');
    expect(retry.ids).toEqual(['u_000']);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete rows' })).toBeNull());
  });

  it('cancel on the delete dialog is a no-op (no confirm call)', async () => {
    const transport = new FakeAdminTransport(fakeTable());
    renderData('/data?model=user', transport);
    await screen.findByText('user000@example.com');

    fireEvent.click(screen.getByLabelText('Select row u_000'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete (1)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete rows' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog', { name: 'Delete rows' })).toBeNull();
    expect(callsFor(transport, 'data.deleteRows')).toHaveLength(1);
  });

  it('offers soft/hard on a soft-delete model and hard-only otherwise', async () => {
    const softTransport = new FakeAdminTransport(fakeTable());
    renderData('/data?model=user', softTransport);
    await screen.findByText('user000@example.com');
    // Default mode is soft for a soft-delete model.
    fireEvent.click(screen.getByLabelText('Select row u_000'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete (1)' }));
    expect(await screen.findByText('soft-delete 1 rows from user')).toBeTruthy();

    cleanup();

    const hardTransport = new FakeAdminTransport(fakeTable());
    renderData('/data?model=post', hardTransport);
    await screen.findByText('p_00');
    // A non-soft model exposes no mode toggle and deletes hard.
    expect(screen.queryByLabelText('Delete mode')).toBeNull();
    fireEvent.click(screen.getByLabelText('Select row p_00'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete (1)' }));
    expect(await screen.findByText('hard-delete 1 rows from post')).toBeTruthy();
  });

  it('clears a table through the confirm challenge', async () => {
    const transport = new FakeAdminTransport(fakeTable());
    renderData('/data?model=post', transport);
    await screen.findByText('p_00');

    fireEvent.click(screen.getByRole('button', { name: 'Clear table' }));
    expect(await screen.findByText(/clear all \d+ rows from post/)).toBeTruthy();

    const dialog = screen.getByRole('dialog', { name: 'Clear table' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear' }));

    await waitFor(() => expect(callsFor(transport, 'data.clearTable')).toHaveLength(2));
    const retry = callsFor(transport, 'data.clearTable')[1].args as { confirmToken: string };
    expect(retry.confirmToken).not.toBe('');
  });

  it('surfaces the server cap hint when generateRows exceeds the max', async () => {
    const transport = new FakeAdminTransport(fakeTable());
    renderData('/data?model=user', transport);
    await screen.findByText('user000@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Generate rows' }));
    fireEvent.change(await screen.findByLabelText('Row count'), { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    expect(
      await screen.findByText((content) => content.includes('Maximum 1000 rows per generate')),
    ).toBeTruthy();
  });

  it('hides every write affordance when dataEditable is false', async () => {
    const transport = new FakeAdminTransport(
      fakeTable({ 'studio.capabilities': capabilitiesReadOnly }),
    );
    renderData('/data?model=user', transport);
    await screen.findByText('user000@example.com');

    expect(screen.queryByRole('button', { name: 'New row' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Generate rows' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear table' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Row actions' })).toBeNull();
    expect(screen.queryByLabelText('Select all rows')).toBeNull();

    // The row-detail drawer offers no Edit affordance either.
    fireEvent.click(gridRows()[0]);
    await screen.findByRole('dialog', { name: /Row/ });
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });
});
