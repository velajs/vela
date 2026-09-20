import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  capabilitiesDegraded,
  capabilitiesReadOnly,
  FakeAdminTransport,
  fakeTable,
} from '@velajs/studio-fixtures';
import TimeTravelPanel from '../src/panels/time-travel';
import { AdminClientProvider } from '../src/data/context';

afterEach(cleanup);

function mount(transport: FakeAdminTransport): void {
  render(
    <AdminClientProvider transport={transport}>
      <TimeTravelPanel />
    </AdminClientProvider>,
  );
}

const callsFor = (t: FakeAdminTransport, op: string) => t.calls.filter((c) => c.op === op);

/** Click the Preview button in the snapshot row whose Mark cell reads `id`. */
async function previewMark(id: string): Promise<void> {
  const cell = await screen.findByText(id);
  const row = cell.closest('tr');
  if (row === null) throw new Error(`no row for mark ${id}`);
  fireEvent.click(within(row).getByRole('button', { name: 'Preview' }));
}

describe('time travel panel — degraded', () => {
  it('renders "not configured" when no port is bound (timeTravel: null)', async () => {
    const transport = new FakeAdminTransport(
      fakeTable({ 'studio.capabilities': capabilitiesDegraded }),
    );
    mount(transport);
    expect(await screen.findByText('Time travel is not configured')).toBeTruthy();
    // No port ⇒ the panel never queries marks.
    expect(callsFor(transport, 'timeTravel.currentMark')).toHaveLength(0);
  });
});

describe('time travel panel — restore lifecycle', () => {
  it('preview → 428 challenge → confirm → armRestore retries with the token', async () => {
    const transport = new FakeAdminTransport(fakeTable());
    mount(transport);

    // The snapshot list loaded, current mark visible.
    await previewMark('snap-2');

    // Preview readout: affected tables + schema-compatible verdict.
    expect(await screen.findByText('Schema is compatible with the current models.')).toBeTruthy();

    // First arm attempt is challenged: the server summary lands in the dialog.
    fireEvent.click(screen.getByRole('button', { name: 'Restore to this mark' }));
    expect(
      await screen.findByText(
        'restore data to snapshot snap-2 (this overwrites current rows; an undo mark is created)',
      ),
    ).toBeTruthy();
    expect(callsFor(transport, 'timeTravel.armRestore')).toHaveLength(1);

    const dialog = screen.getByRole('dialog', { name: 'Restore data' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));

    // Confirmed retry carries the minted token; outcome surfaces the undo mark.
    await waitFor(() => expect(callsFor(transport, 'timeTravel.armRestore')).toHaveLength(2));
    const retry = callsFor(transport, 'timeTravel.armRestore')[1].args as { confirmToken: string };
    expect(retry.confirmToken).not.toBe('');
    expect(await screen.findByRole('button', { name: 'Undo (back to undo-1)' })).toBeTruthy();
  });

  it('undo rides the same confirm challenge back to the undo mark', async () => {
    const transport = new FakeAdminTransport(fakeTable());
    mount(transport);

    await previewMark('snap-2');
    fireEvent.click(await screen.findByRole('button', { name: 'Restore to this mark' }));
    const restoreDialog = await screen.findByRole('dialog', { name: 'Restore data' });
    fireEvent.click(within(restoreDialog).getByRole('button', { name: 'Restore' }));

    const undoBtn = await screen.findByRole('button', { name: 'Undo (back to undo-1)' });
    fireEvent.click(undoBtn);

    expect(
      await screen.findByText('undo the last restore, returning data to mark undo-1'),
    ).toBeTruthy();
    expect(callsFor(transport, 'timeTravel.undo')).toHaveLength(1);

    const undoDialog = screen.getByRole('dialog', { name: 'Undo restore' });
    fireEvent.click(within(undoDialog).getByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(callsFor(transport, 'timeTravel.undo')).toHaveLength(2));
    // The restore now points at the undo mark (undo is itself reversible).
    expect(await screen.findByText('undo-1')).toBeTruthy();
  });
});

describe('time travel panel — schema mismatch', () => {
  it('warns and blocks restore on a schema-incompatible mark until forced', async () => {
    const transport = new FakeAdminTransport(fakeTable());
    mount(transport);

    await previewMark('snap-legacy');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Schema mismatch');
    expect(alert.textContent).toContain('user');

    // Restore is disabled while incompatible and unforced.
    const restoreBtn = screen.getByRole('button', { name: 'Restore to this mark' });
    expect(restoreBtn).toHaveProperty('disabled', true);

    // Forcing re-enables it.
    fireEvent.click(screen.getByLabelText('Force restore despite schema mismatch'));
    expect(screen.getByRole('button', { name: 'Restore to this mark' })).toHaveProperty(
      'disabled',
      false,
    );
  });
});

describe('time travel panel — write gating', () => {
  it('hides restore + prune affordances when timeTravelRestore is closed', async () => {
    const transport = new FakeAdminTransport(
      fakeTable({ 'studio.capabilities': capabilitiesReadOnly }),
    );
    mount(transport);

    // Previewing still works (read), but no restore control appears.
    await previewMark('snap-2');
    expect(await screen.findByText('Schema is compatible with the current models.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Restore to this mark' })).toBeNull();
    // Prune is gated on writes.timeTravelRestore.
    expect(screen.queryByRole('button', { name: 'Prune snapshots' })).toBeNull();
  });
});
