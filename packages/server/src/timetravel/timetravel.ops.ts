/**
 * The nine `timeTravel.*` ops, authored ONCE against the bound
 * {@link TimeTravelPort} (portable snapshot adapter today, CF-DO PITR in M11).
 * Registered UNCONDITIONALLY by the core `StudioModule` so the wire surface is
 * stable; every handler resolves the port lazily and reports
 * `TIMETRAVEL_UNAVAILABLE` (409) when no port is bound.
 *
 * Destructive ops (`armRestore`, `undo`, `prune`) ride the SAME generic 428
 * confirm challenge as every other destructive Studio op — the dispatch registry
 * verifies + consumes the `confirmToken` (bound to op + payload) BEFORE these
 * handlers run; each provides its human summary via `@AdminConfirmSummary`. The
 * handlers audit intent before the destructive call and the outcome after, so a
 * mid-restore failure still leaves an audit trail (mark id + subject).
 *
 * `undo` is not a distinct port method: it restores to the `undoMark` an earlier
 * restore returned (`armRestore({ bookmark: undoMark })`), which itself yields a
 * fresh undo mark — so undo is reversible too.
 */
import { Container, Inject, Injectable } from '@velajs/vela';
import type {
  RestoreOutcome,
  RestorePreview,
  RetentionPolicy,
  StudioOpReq,
  TimeTravelCapabilities,
  TimeTravelMark,
  TimeTravelMarkPage,
} from '@velajs/studio-protocol';
import { AdminConfirmSummary, AdminRpc } from '../rpc/admin-rpc.decorator';
import type { AdminOpContext } from '../studio.types';
import { studioError } from '../studio.errors';
import { TIME_TRAVEL_PORT } from './port.token';
import type { TimeTravelPort } from '@velajs/studio-protocol';

@Injectable()
export class StudioTimeTravelOps {
  constructor(@Inject(Container) private readonly container: Container) {}

  // -- reads -----------------------------------------------------------------

  @AdminRpc({ op: 'timeTravel.capabilities' })
  capabilities(
    _ctx: AdminOpContext,
    args: StudioOpReq<'timeTravel.capabilities'>,
  ): TimeTravelCapabilities {
    return this.port().capabilities(args.scope);
  }

  @AdminRpc({ op: 'timeTravel.currentMark' })
  currentMark(
    _ctx: AdminOpContext,
    args: StudioOpReq<'timeTravel.currentMark'>,
  ): Promise<TimeTravelMark> {
    return this.port().getCurrentMark(args.scope);
  }

  @AdminRpc({ op: 'timeTravel.markForTime' })
  markForTime(
    _ctx: AdminOpContext,
    args: StudioOpReq<'timeTravel.markForTime'>,
  ): Promise<TimeTravelMark | null> {
    const port = this.port();
    if (port.getMarkForTime === undefined) {
      throw studioError(
        'FEATURE_UNCONFIGURED',
        'this time-travel port cannot address marks by time',
      );
    }
    return port.getMarkForTime(args.time, args.scope);
  }

  @AdminRpc({ op: 'timeTravel.listMarks' })
  listMarks(
    _ctx: AdminOpContext,
    args: StudioOpReq<'timeTravel.listMarks'>,
  ): Promise<TimeTravelMarkPage> {
    const port = this.port();
    if (port.listMarks === undefined) {
      throw studioError(
        'FEATURE_UNCONFIGURED',
        'this time-travel port does not support listing marks',
      );
    }
    return port.listMarks(args.scope, {
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.before !== undefined ? { before: args.before } : {}),
    });
  }

  @AdminRpc({ op: 'timeTravel.preview' })
  preview(_ctx: AdminOpContext, args: StudioOpReq<'timeTravel.preview'>): Promise<RestorePreview> {
    return this.port().preview(args.target, args.scope);
  }

  // -- destructive (428 confirm) --------------------------------------------

  @AdminRpc({ op: 'timeTravel.armRestore' })
  async armRestore(
    ctx: AdminOpContext,
    args: StudioOpReq<'timeTravel.armRestore'>,
  ): Promise<RestoreOutcome> {
    const port = this.port();
    const target = restoreTargetLabel(args);
    // Intent, audited BEFORE the destructive apply (survives a mid-restore throw).
    ctx.audit({
      target,
      summary: `restore data to ${target}`,
      extra: { subject: ctx.admin.subject },
    });
    const outcome = await port.armRestore(args);
    ctx.audit({
      target: outcome.restoredTo,
      summary: `restored data to snapshot ${outcome.restoredTo}`,
      extra: {
        subject: ctx.admin.subject,
        restoredTo: outcome.restoredTo,
        ...(outcome.undoMark !== undefined ? { undoMark: outcome.undoMark.id } : {}),
        applied: outcome.applied,
      },
    });
    return outcome;
  }

  @AdminConfirmSummary({ op: 'timeTravel.armRestore' })
  armRestoreSummary(_ctx: AdminOpContext, args: StudioOpReq<'timeTravel.armRestore'>): string {
    return `restore data to ${restoreTargetLabel(args)} (this overwrites current rows; an undo mark is created)`;
  }

  @AdminRpc({ op: 'timeTravel.undo' })
  async undo(ctx: AdminOpContext, args: StudioOpReq<'timeTravel.undo'>): Promise<RestoreOutcome> {
    const port = this.port();
    ctx.audit({
      target: args.undoMark,
      summary: `undo restore (to mark ${args.undoMark})`,
      extra: { subject: ctx.admin.subject },
    });
    const outcome = await port.armRestore({
      bookmark: args.undoMark,
      ...(args.scope !== undefined ? { scope: args.scope } : {}),
      confirmToken: args.confirmToken,
    });
    ctx.audit({
      target: outcome.restoredTo,
      summary: `undid restore — data at mark ${outcome.restoredTo}`,
      extra: {
        subject: ctx.admin.subject,
        restoredTo: outcome.restoredTo,
        ...(outcome.undoMark !== undefined ? { undoMark: outcome.undoMark.id } : {}),
      },
    });
    return outcome;
  }

  @AdminConfirmSummary({ op: 'timeTravel.undo' })
  undoSummary(_ctx: AdminOpContext, args: StudioOpReq<'timeTravel.undo'>): string {
    return `undo the last restore, returning data to mark ${args.undoMark}`;
  }

  @AdminRpc({ op: 'timeTravel.prune' })
  async prune(
    ctx: AdminOpContext,
    args: StudioOpReq<'timeTravel.prune'>,
  ): Promise<{ pruned: number }> {
    const port = this.port();
    if (port.prune === undefined) {
      throw studioError('FEATURE_UNCONFIGURED', 'this time-travel port does not support pruning');
    }
    ctx.audit({ summary: pruneSummary(args.retention), extra: { subject: ctx.admin.subject } });
    const result = await port.prune(args.retention, args.scope);
    ctx.audit({
      summary: `pruned ${result.pruned} snapshot${result.pruned === 1 ? '' : 's'}`,
      extra: { subject: ctx.admin.subject, pruned: result.pruned, retention: args.retention },
    });
    return result;
  }

  @AdminConfirmSummary({ op: 'timeTravel.prune' })
  pruneSummary(_ctx: AdminOpContext, args: StudioOpReq<'timeTravel.prune'>): string {
    return pruneSummary(args.retention);
  }

  // -- create (write, non-destructive) --------------------------------------

  @AdminRpc({ op: 'timeTravel.createSnapshot' })
  async createSnapshot(
    ctx: AdminOpContext,
    args: StudioOpReq<'timeTravel.createSnapshot'>,
  ): Promise<TimeTravelMark> {
    const port = this.port();
    if (port.createSnapshot === undefined) {
      throw studioError(
        'FEATURE_UNCONFIGURED',
        'this time-travel port cannot create snapshots on demand',
      );
    }
    const mark = await port.createSnapshot(args);
    ctx.audit({
      target: mark.id,
      summary: `created snapshot ${mark.id}`,
      extra: { subject: ctx.admin.subject, mark: mark.id },
    });
    return mark;
  }

  /** The bound port, or `TIMETRAVEL_UNAVAILABLE` when no port module is wired. */
  private port(): TimeTravelPort {
    if (!this.container.has(TIME_TRAVEL_PORT)) throw studioError('TIMETRAVEL_UNAVAILABLE');
    return this.container.resolve(TIME_TRAVEL_PORT);
  }
}

/** A human label for a restore target (mark id or point in time). */
function restoreTargetLabel(args: { bookmark?: string; time?: number | string }): string {
  if (args.bookmark !== undefined) return `snapshot ${args.bookmark}`;
  if (args.time !== undefined) return `time ${new Date(toEpochLabel(args.time)).toISOString()}`;
  return 'the requested point';
}

function toEpochLabel(time: number | string): number {
  const t = typeof time === 'number' ? time : Date.parse(time);
  return Number.isNaN(t) ? 0 : t;
}

/** A human summary of a prune retention policy. */
function pruneSummary(retention: RetentionPolicy): string {
  const parts: string[] = [];
  if (retention.keepLast !== undefined) parts.push(`keep the newest ${retention.keepLast}`);
  if (retention.maxAgeMs !== undefined) {
    parts.push(`drop snapshots older than ${Math.round(retention.maxAgeMs / 86_400_000)}d`);
  }
  return `prune snapshots (${parts.length > 0 ? parts.join('; ') : 'no-op policy'})`;
}
