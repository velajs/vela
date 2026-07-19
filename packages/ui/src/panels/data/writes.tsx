/**
 * The data-panel write toolbar: create ("New row"), generate synthetic rows,
 * bulk delete (soft/hard), and clear table. Only mounted when
 * `writes.dataEditable` is open. The two destructive actions (delete, clear)
 * route through {@link useConfirmedMutation}, so a first attempt surfaces the
 * server's 428 `summary` in a {@link ConfirmDialog} and confirming re-fires with
 * the single-use token; create/generate are plain gated writes that invalidate
 * the row list on success.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { StudioModelDescriptor } from '@velajs/studio-protocol';
import { useAdminMutation } from '../../data/query';
import { useConfirmedMutation } from '../../data/use-confirmed-mutation';
import { ConfirmDialog, Drawer, useDialogA11y } from '../shared';
import { RowForm } from './row-form';

/** A small count-input dialog for `data.generateRows`, surfacing the cap hint. */
function GenerateDialog({ model, onClose }: { model: string; onClose: () => void }): ReactNode {
  const [count, setCount] = useState('10');
  const generate = useAdminMutation('data.generateRows', { invalidates: ['data.listRows'] });
  // Only mounted while generating, so the trap is always active here.
  const dialogRef = useDialogA11y(true, onClose);

  const submit = (): void => {
    const n = Number(count);
    if (!Number.isFinite(n) || n <= 0) return;
    generate.mutate({ model, count: n }, { onSuccess: onClose });
  };

  return (
    <div
      ref={dialogRef}
      className="vela-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Generate rows"
      onClick={onClose}
    >
      <div className="vela-modal__box" onClick={(event) => event.stopPropagation()}>
        <h2 className="vela-modal__title">Generate rows</h2>
        <label className="vela-form__field">
          <span className="vela-form__label">count</span>
          <input
            className="vela-input"
            type="number"
            aria-label="Row count"
            value={count}
            min={1}
            onChange={(event) => setCount(event.target.value)}
          />
        </label>
        {generate.error !== null ? (
          <p className="vela-state__message" role="alert">
            {generate.error.hint ?? generate.error.body.message}
          </p>
        ) : null}
        <div className="vela-modal__actions">
          <button
            type="button"
            className="vela-btn"
            onClick={onClose}
            disabled={generate.isPending}
          >
            Cancel
          </button>
          <button
            type="button"
            className="vela-btn vela-btn--primary"
            onClick={submit}
            disabled={generate.isPending}
          >
            Generate
          </button>
        </div>
      </div>
    </div>
  );
}

export interface DataWritesProps {
  descriptor: StudioModelDescriptor;
  selectedIds: ReadonlySet<string>;
  onClearSelection: () => void;
}

export function DataWrites({
  descriptor,
  selectedIds,
  onClearSelection,
}: DataWritesProps): ReactNode {
  const model = descriptor.name;
  const softCapable = descriptor.flags.softDelete;
  const [creating, setCreating] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [deleteMode, setDeleteMode] = useState<'soft' | 'hard'>(softCapable ? 'soft' : 'hard');

  const create = useAdminMutation('data.writeRow', { invalidates: ['data.listRows'] });
  const del = useConfirmedMutation('data.deleteRows', {
    invalidates: ['data.listRows'],
    onSuccess: onClearSelection,
  });
  const clear = useConfirmedMutation('data.clearTable', { invalidates: ['data.listRows'] });

  const ids = [...selectedIds];

  const closeCreate = (): void => {
    setCreating(false);
    create.reset();
  };

  return (
    <div className="vela-data__writes" role="group" aria-label="Row actions">
      <button type="button" className="vela-btn" onClick={() => setCreating(true)}>
        New row
      </button>
      <button type="button" className="vela-btn" onClick={() => setGenerating(true)}>
        Generate rows
      </button>

      {softCapable ? (
        <label className="vela-check">
          <span>Delete mode</span>
          <select
            className="vela-select"
            aria-label="Delete mode"
            value={deleteMode}
            onChange={(event) => setDeleteMode(event.target.value === 'hard' ? 'hard' : 'soft')}
          >
            <option value="soft">soft</option>
            <option value="hard">hard</option>
          </select>
        </label>
      ) : null}

      <button
        type="button"
        className="vela-btn vela-btn--danger"
        disabled={ids.length === 0 || del.isPending}
        onClick={() => del.mutate({ model, ids, mode: deleteMode, confirmToken: '' })}
      >
        Delete{ids.length > 0 ? ` (${ids.length})` : ''}
      </button>
      <button
        type="button"
        className="vela-btn vela-btn--danger"
        disabled={clear.isPending}
        onClick={() => clear.mutate({ model, confirmToken: '' })}
      >
        Clear table
      </button>

      {del.error !== null ? (
        <p className="vela-state__message" role="alert">
          {del.error.hint ?? del.error.body.message}
        </p>
      ) : null}
      {clear.error !== null ? (
        <p className="vela-state__message" role="alert">
          {clear.error.hint ?? clear.error.body.message}
        </p>
      ) : null}

      <Drawer open={creating} title={`New ${model} row`} onClose={closeCreate}>
        <RowForm
          columns={descriptor.columns}
          mode="create"
          busy={create.isPending}
          error={create.error}
          onCancel={closeCreate}
          onSubmit={(patch) => create.mutate({ model, patch }, { onSuccess: closeCreate })}
        />
      </Drawer>

      {generating ? <GenerateDialog model={model} onClose={() => setGenerating(false)} /> : null}

      <ConfirmDialog
        pending={del.pendingConfirm}
        title="Delete rows"
        confirmLabel="Delete"
        busy={del.isPending}
        onConfirm={del.confirm}
        onCancel={del.cancel}
      />
      <ConfirmDialog
        pending={clear.pendingConfirm}
        title="Clear table"
        confirmLabel="Clear"
        busy={clear.isPending}
        onConfirm={clear.confirm}
        onCancel={clear.cancel}
      />
    </div>
  );
}
