/**
 * The Time Travel panel — capability-driven data restore over the portable
 * snapshot tier (M8b). Everything the panel offers is derived from the negotiated
 * {@link TimeTravelCapabilities} (NOT an adapter enum): the mark list appears only
 * when `list`, pick-a-time only when `markByTime`, the undo affordance only when
 * `undo` (and a prior restore returned an undo mark), create-snapshot only when
 * `createOnDemand`, and the export indicator only when `portableExport`. The two
 * destructive flows — restore and prune — are additionally hidden unless
 * `writes.timeTravelRestore` is open, and each rides {@link useConfirmedMutation}:
 * the op is fired with an empty token, the server's 428 `summary` surfaces in a
 * {@link ConfirmDialog}, and confirming re-fires with the single-use token.
 *
 * The honest `scopeNote` is shown prominently — a restore only rewinds the
 * managed crud rows, never external stores. When no port is bound
 * (`capabilities.timeTravel === null`) the panel renders a defensive
 * "not configured" state (the nav already hides the tab).
 *
 * NOTE: `portableExport` advertises that a snapshot can be downloaded
 * off-platform, but the frozen protocol exposes no `timeTravel.export` RPC op yet
 * (it lands with `transfer.export` in a later milestone over a dedicated HTTP
 * route). The export control is therefore rendered visibly disabled — it calls no
 * op — rather than wired to a missing endpoint.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import type {
  RestoreOutcome,
  RestorePreview,
  RestoreTarget,
  TimeTravelCapabilities,
  TimeTravelMark,
} from '@velajs/studio-protocol';
import { useStudioCapabilities } from '../data/capabilities';
import { useAdminMutation, useAdminQuery } from '../data/query';
import { useConfirmedMutation } from '../data/use-confirmed-mutation';
import { Panel, QueryView, Badge, ConfirmDialog, AdminErrorView } from './shared';
import { formatTimestamp } from './format';

const REFRESH_MS = 15_000;

/** A boolean capability rendered as an on/off badge. */
function CapBadge({ label, on }: { label: string; on: boolean }): ReactNode {
  return <Badge tone={on ? 'success' : 'muted'}>{on ? label : `${label} off`}</Badge>;
}

function CapabilityBar({ caps }: { caps: TimeTravelCapabilities }): ReactNode {
  return (
    <div className="vela-tt__caps" aria-label="Time travel capabilities">
      <Badge tone="accent">{caps.granularity}</Badge>
      <CapBadge label="mark by time" on={caps.markByTime} />
      <CapBadge label="list" on={caps.list} />
      <CapBadge label="undo" on={caps.undo} />
      <CapBadge label="in place" on={caps.inPlace} />
      {caps.restartRequired ? <Badge tone="warn">restart required</Badge> : null}
      <CapBadge label="portable export" on={caps.portableExport} />
      <CapBadge label="create on demand" on={caps.createOnDemand} />
    </div>
  );
}

function MarkSummary({ mark }: { mark: TimeTravelMark }): ReactNode {
  return (
    <div className="vela-tt__mark-summary">
      <span className="vela-mono">{mark.id}</span>
      {mark.label !== undefined ? <span className="vela-tt__mark-label">{mark.label}</span> : null}
      <span className="vela-tt__mark-time">{formatTimestamp(mark.time)}</span>
      {(mark.tables ?? []).map((table) => (
        <Badge key={table} tone="neutral">
          {table}
        </Badge>
      ))}
    </div>
  );
}

/** The affected-tables + schema-compat readout for a resolved preview target. */
function PreviewReadout({ preview }: { preview: RestorePreview }): ReactNode {
  return (
    <div className="vela-tt__preview">
      <MarkSummary mark={preview.target} />
      {!preview.schemaCompatible ? (
        <p className="vela-state__message" role="alert">
          Schema mismatch: the snapshot no longer matches the current schema for{' '}
          <strong>{preview.incompatibleTables.join(', ')}</strong>. Restoring would fail unless
          forced (dev-host only).
        </p>
      ) : (
        <p className="vela-tt__ok">Schema is compatible with the current models.</p>
      )}
      <table className="vela-table">
        <thead>
          <tr>
            <th>Table</th>
            <th>Approx rows</th>
          </tr>
        </thead>
        <tbody>
          {preview.affectedTables.map((t) => (
            <tr key={t.table}>
              <td className="vela-mono">{t.table}</td>
              <td className="vela-mono">{t.approxRows ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="vela-tt__preview-flags">
        {preview.undoAvailable ? <Badge tone="neutral">undo available</Badge> : null}
        {preview.restartRequired ? <Badge tone="warn">restart required</Badge> : null}
      </div>
    </div>
  );
}

function TimeTravelBody({
  caps,
  canRestore,
}: {
  caps: TimeTravelCapabilities;
  canRestore: boolean;
}): ReactNode {
  const [target, setTarget] = useState<RestoreTarget | null>(null);
  const [timeInput, setTimeInput] = useState('');
  const [force, setForce] = useState(false);
  const [pruneKeep, setPruneKeep] = useState('3');
  const [lastOutcome, setLastOutcome] = useState<RestoreOutcome | null>(null);

  const current = useAdminQuery('timeTravel.currentMark', {}, { refetchInterval: REFRESH_MS });
  const marks = useAdminQuery('timeTravel.listMarks', {}, { enabled: caps.list });
  const preview = useAdminQuery(
    'timeTravel.preview',
    { target: target ?? {} },
    { enabled: target !== null },
  );

  const create = useAdminMutation('timeTravel.createSnapshot', {
    invalidates: ['timeTravel.currentMark', 'timeTravel.listMarks'],
  });
  const restore = useConfirmedMutation('timeTravel.armRestore', {
    invalidates: ['timeTravel.currentMark', 'timeTravel.listMarks'],
    onSuccess: (outcome) => {
      setLastOutcome(outcome);
      setTarget(null);
      setForce(false);
    },
  });
  const undo = useConfirmedMutation('timeTravel.undo', {
    invalidates: ['timeTravel.currentMark', 'timeTravel.listMarks'],
    onSuccess: (outcome) => setLastOutcome(outcome),
  });
  const prune = useConfirmedMutation('timeTravel.prune', {
    invalidates: ['timeTravel.currentMark', 'timeTravel.listMarks'],
  });

  const selectMark = (mark: TimeTravelMark): void => {
    restore.reset();
    setForce(false);
    setTarget({ bookmark: mark.id });
  };

  const previewAtTime = (): void => {
    if (timeInput === '') return;
    restore.reset();
    setForce(false);
    setTarget({ time: timeInput });
  };

  const startRestore = (): void => {
    if (target === null) return;
    restore.mutate({ ...target, ...(force ? { force: true } : {}), confirmToken: '' });
  };

  const previewReady = preview.data !== undefined && target !== null;
  const canArm =
    previewReady && preview.data !== undefined && (preview.data.schemaCompatible || force);
  const undoMark = lastOutcome?.undoMark;

  return (
    <div className="vela-tt">
      <p className="vela-note vela-tt__scope">{caps.scopeNote}</p>
      <CapabilityBar caps={caps} />

      <section className="vela-card vela-tt__section" aria-label="Current mark">
        <h2 className="vela-card__title">Current mark</h2>
        <QueryView result={current} loadingLabel="Reading current mark…">
          {(mark) => <MarkSummary mark={mark} />}
        </QueryView>
        <div className="vela-tt__row">
          {caps.createOnDemand ? (
            <button
              type="button"
              className="vela-btn"
              disabled={create.isPending}
              onClick={() => create.mutate({})}
            >
              Create snapshot
            </button>
          ) : null}
          {caps.portableExport ? (
            <button
              type="button"
              className="vela-btn"
              disabled
              title="Snapshot export lands in a later release."
            >
              Export
            </button>
          ) : null}
        </div>
        {caps.portableExport ? (
          <p className="vela-state__hint">
            Portable export (off-platform download) is available in a later release.
          </p>
        ) : null}
        {create.error !== null ? (
          <p className="vela-state__message" role="alert">
            {create.error.hint ?? create.error.body.message}
          </p>
        ) : null}
      </section>

      {caps.list ? (
        <section className="vela-card vela-tt__section" aria-label="Snapshots">
          <h2 className="vela-card__title">Snapshots</h2>
          <QueryView
            result={marks}
            isEmpty={(page) => page.marks.length === 0}
            emptyLabel="No snapshots captured yet."
          >
            {(page) => (
              <table className="vela-table">
                <thead>
                  <tr>
                    <th>Mark</th>
                    <th>Label</th>
                    <th>Created</th>
                    <th>Tables</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {page.marks.map((mark) => (
                    <tr key={mark.id}>
                      <td className="vela-mono">{mark.id}</td>
                      <td>{mark.label ?? '—'}</td>
                      <td className="vela-mono">{formatTimestamp(mark.time)}</td>
                      <td className="vela-mono">{(mark.tables ?? []).join(', ')}</td>
                      <td>
                        <button type="button" className="vela-btn" onClick={() => selectMark(mark)}>
                          Preview
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </QueryView>
        </section>
      ) : null}

      {caps.markByTime ? (
        <section className="vela-card vela-tt__section" aria-label="Restore to a point in time">
          <h2 className="vela-card__title">Point in time</h2>
          <div className="vela-tt__row">
            <input
              className="vela-input"
              type="datetime-local"
              aria-label="Restore point in time"
              value={timeInput}
              onChange={(event) => setTimeInput(event.target.value)}
            />
            <button
              type="button"
              className="vela-btn"
              disabled={timeInput === ''}
              onClick={previewAtTime}
            >
              Preview at time
            </button>
          </div>
        </section>
      ) : null}

      {target !== null ? (
        <section className="vela-card vela-tt__section" aria-label="Restore preview">
          <h2 className="vela-card__title">Restore preview</h2>
          {preview.error !== null ? (
            <AdminErrorView error={preview.error} />
          ) : preview.data === undefined ? (
            <p className="vela-state__hint">Computing preview…</p>
          ) : (
            <>
              <PreviewReadout preview={preview.data} />
              {canRestore ? (
                <div className="vela-tt__restore">
                  {!preview.data.schemaCompatible ? (
                    <label className="vela-check">
                      <input
                        type="checkbox"
                        checked={force}
                        onChange={(event) => setForce(event.target.checked)}
                      />
                      <span>Force restore despite schema mismatch</span>
                    </label>
                  ) : null}
                  <div className="vela-tt__row">
                    <button
                      type="button"
                      className="vela-btn vela-btn--danger"
                      disabled={!canArm || restore.isPending}
                      onClick={startRestore}
                    >
                      Restore to this mark
                    </button>
                    <button type="button" className="vela-btn" onClick={() => setTarget(null)}>
                      Cancel
                    </button>
                  </div>
                  {restore.error !== null ? (
                    <p className="vela-state__message" role="alert">
                      {restore.error.hint ?? restore.error.body.message}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : null}

      {lastOutcome !== null ? (
        <section className="vela-card vela-tt__section" aria-label="Last restore">
          <h2 className="vela-card__title">Last restore</h2>
          <p className="vela-tt__outcome">
            Restored to <span className="vela-mono">{lastOutcome.restoredTo}</span>.{' '}
            {lastOutcome.applied ? 'Applied in place.' : 'Armed for next restart.'}
          </p>
          {caps.undo && canRestore && undoMark !== undefined ? (
            <button
              type="button"
              className="vela-btn vela-btn--danger"
              disabled={undo.isPending}
              onClick={() => undo.mutate({ undoMark: undoMark.id, confirmToken: '' })}
            >
              Undo (back to {undoMark.id})
            </button>
          ) : null}
          {undo.error !== null ? (
            <p className="vela-state__message" role="alert">
              {undo.error.hint ?? undo.error.body.message}
            </p>
          ) : null}
        </section>
      ) : null}

      {canRestore ? (
        <section className="vela-card vela-tt__section" aria-label="Prune snapshots">
          <h2 className="vela-card__title">Prune</h2>
          <div className="vela-tt__row">
            <label className="vela-check">
              <span>Keep newest</span>
              <input
                className="vela-input vela-tt__keep"
                type="number"
                min={0}
                aria-label="Keep newest snapshots"
                value={pruneKeep}
                onChange={(event) => setPruneKeep(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="vela-btn vela-btn--danger"
              disabled={prune.isPending}
              onClick={() =>
                prune.mutate({
                  retention: { keepLast: Math.max(0, Number(pruneKeep) || 0) },
                  confirmToken: '',
                })
              }
            >
              Prune snapshots
            </button>
          </div>
          {prune.data !== undefined ? (
            <p className="vela-tt__outcome">Pruned {prune.data.pruned} snapshot(s).</p>
          ) : null}
          {prune.error !== null ? (
            <p className="vela-state__message" role="alert">
              {prune.error.hint ?? prune.error.body.message}
            </p>
          ) : null}
        </section>
      ) : null}

      <ConfirmDialog
        pending={restore.pendingConfirm}
        title="Restore data"
        confirmLabel="Restore"
        busy={restore.isPending}
        onConfirm={restore.confirm}
        onCancel={restore.cancel}
      />
      <ConfirmDialog
        pending={undo.pendingConfirm}
        title="Undo restore"
        confirmLabel="Undo"
        busy={undo.isPending}
        onConfirm={undo.confirm}
        onCancel={undo.cancel}
      />
      <ConfirmDialog
        pending={prune.pendingConfirm}
        title="Prune snapshots"
        confirmLabel="Prune"
        busy={prune.isPending}
        onConfirm={prune.confirm}
        onCancel={prune.cancel}
      />
    </div>
  );
}

export default function TimeTravelPanel(): ReactNode {
  const { capabilities } = useStudioCapabilities();
  const caps = capabilities.timeTravel;
  const canRestore = capabilities.writes.timeTravelRestore;

  return (
    <Panel
      title="Time Travel"
      description="Restore managed data to an earlier snapshot. Portable snapshot tier."
    >
      {caps === null ? (
        <div className="vela-state vela-state--empty" role="status">
          <p className="vela-state__label">Time travel is not configured</p>
          <p className="vela-state__hint">
            No time-travel port is bound for this deployment. Bind the portable snapshot adapter (or
            a platform PITR adapter) to enable restore.
          </p>
        </div>
      ) : (
        <TimeTravelBody caps={caps} canRestore={canRestore} />
      )}
    </Panel>
  );
}
