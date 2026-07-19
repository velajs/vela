/**
 * The data-browser WRITE ops: `data.writeRow`, `data.deleteRows`,
 * `data.clearTable`, `data.generateRows`. Authored ONCE against the
 * {@link STUDIO_MODEL_SOURCE} port — this provider knows nothing about crud, so
 * a BYO write-capable source binds the same token.
 *
 * Registered by the source-binding module (`StudioCrudModule`), NOT the core
 * `StudioModule`: a write op only makes sense with a bound source, and keeping
 * it off the core surface means an app without a source never advertises a write
 * handler (the read ops stay on core for a stable read surface). Gating,
 * destructive-confirm (428), and audit recording are all applied by the dispatch
 * registry AROUND these handlers; each handler adds the before/after images and
 * the human summary to its audit row.
 *
 * `runAsIdentity`: when the `identity` editable gate is open and an identity is
 * configured, it is threaded into the source write context (a kernel-ready seam)
 * and its subject is stamped on the audit row. M1: in THIS adapter-direct path
 * runAsIdentity is audit-subject-only — the subject is recorded on the audit row
 * but the write is NOT policy-scoped by it (no per-identity authorization or row
 * filtering); policy-scoped impersonation lands with the kernel path (matches
 * the M7a report ledger).
 */
import { Container, Inject, Injectable } from '@velajs/vela';
import type {
  ClearTableRequest,
  DeleteRowsRequest,
  GenerateRowsRequest,
  GenerateRowsResponse,
  WriteRowRequest,
} from '@velajs/studio-protocol';
import { AdminConfirmSummary, AdminRpc } from '../rpc/admin-rpc.decorator';
import type { AdminOpContext, ResolvedStudioConfig, StudioRunAsIdentity } from '../studio.types';
import { studioBadRequest, studioError } from '../studio.errors';
import { STUDIO_RESOLVED_CONFIG } from '../tokens';
import { STUDIO_MODEL_SOURCE } from './model-source.port';
import type { StudioModelSource, StudioWriteContext } from './model-source.port';

/**
 * Hard upper bound on the number of synthetic rows a single `data.generateRows`
 * call may insert. The source clamps the LOWER bound (floor to 0); this caps the
 * upper bound so an unbounded `count` cannot exhaust memory or hammer the DB. A
 * request over the cap is rejected as a 400 client error rather than silently
 * clamped, so the caller learns their number was not honored.
 */
export const MAX_GENERATE_ROWS = 1000;

@Injectable()
export class StudioDataWriteOps {
  constructor(@Inject(Container) private readonly container: Container) {}

  // ---- writeRow (create | patch-update) -----------------------------------

  @AdminRpc({ op: 'data.writeRow' })
  async writeRow(ctx: AdminOpContext, args: WriteRowRequest): Promise<Record<string, unknown>> {
    const source = this.writableSource();
    const write = source.writeRow!.bind(source);
    const { ctx: writeCtx, subject } = this.identity(ctx);
    const outcome = await write(args.model, args, writeCtx);
    const created = outcome.before === null;
    ctx.audit({
      target: args.model,
      summary: `${created ? 'create' : 'update'} row in ${args.model}`,
      extra: {
        before: outcome.before,
        after: outcome.after,
        ...(subject !== undefined ? { runAsIdentity: subject } : {}),
      },
    });
    return outcome.after;
  }

  // ---- deleteRows (soft | hard) — destructive -----------------------------

  @AdminRpc({ op: 'data.deleteRows' })
  async deleteRows(ctx: AdminOpContext, args: DeleteRowsRequest): Promise<{ deleted: number }> {
    const source = this.writableSource();
    const remove = source.deleteRows!.bind(source);
    const { ctx: writeCtx, subject } = this.identity(ctx);
    const outcome = await remove(args.model, args, writeCtx);
    ctx.audit({
      target: args.model,
      summary: deleteSummary(args),
      extra: {
        mode: args.mode,
        deleted: outcome.deleted,
        // Bounded: at most MAX_AUDIT_IMAGES before-images are stored; a larger
        // delete records the cap flag so the omission is explicit.
        before: outcome.before,
        beforeCapped: outcome.beforeCapped,
        ...(subject !== undefined ? { runAsIdentity: subject } : {}),
      },
    });
    return { deleted: outcome.deleted };
  }

  @AdminConfirmSummary({ op: 'data.deleteRows' })
  deleteRowsSummary(_ctx: AdminOpContext, args: DeleteRowsRequest): string {
    return deleteSummary(args);
  }

  // ---- clearTable — destructive -------------------------------------------

  @AdminRpc({ op: 'data.clearTable' })
  async clearTable(ctx: AdminOpContext, args: ClearTableRequest): Promise<{ deleted: number }> {
    const source = this.writableSource();
    const clear = source.clearTable!.bind(source);
    const { ctx: writeCtx, subject } = this.identity(ctx);
    const { deleted } = await clear(args.model, args, writeCtx);
    // A full-table wipe records the COUNT, never per-row images.
    ctx.audit({
      target: args.model,
      summary: `cleared ${deleted} row${deleted === 1 ? '' : 's'} from ${args.model}`,
      extra: { deleted, ...(subject !== undefined ? { runAsIdentity: subject } : {}) },
    });
    return { deleted };
  }

  @AdminConfirmSummary({ op: 'data.clearTable' })
  clearTableSummary(_ctx: AdminOpContext, args: ClearTableRequest): string {
    return `clear ALL rows from ${args.model}`;
  }

  // ---- generateRows (synthetic seed) --------------------------------------

  /**
   * Insert `count` synthetic rows derived from column metadata.
   *
   * M2 stopgap: synthetic rows are built column-by-column and inserted WITHOUT
   * uniqueness or schema validation. A synthesized value that collides with a
   * unique column is NOT caught here — on the in-memory source `create` is a
   * pk-keyed upsert so a colliding row may OVERWRITE the existing one, while a
   * SQL source rejects with a driver uniqueness ERROR. `args.overrides` are
   * applied verbatim and CAN set a fixed primary key (every generated row then
   * targets that same pk). A validating generator lands with the kernel path.
   *
   * I2: `count` is hard-capped at {@link MAX_GENERATE_ROWS}; over the cap is a
   * 400, not a silent clamp. runAsIdentity is audit-subject-only here (see the
   * file header) — the adapter-direct path does not policy-scope the write.
   */
  @AdminRpc({ op: 'data.generateRows' })
  async generateRows(
    ctx: AdminOpContext,
    args: GenerateRowsRequest,
  ): Promise<GenerateRowsResponse> {
    const requested = Math.floor(args.count);
    if (requested > MAX_GENERATE_ROWS) {
      throw studioBadRequest(
        `generateRows count ${requested} exceeds the maximum of ${MAX_GENERATE_ROWS}`,
        `request at most ${MAX_GENERATE_ROWS} synthetic rows per call`,
      );
    }
    const source = this.writableSource();
    const generate = source.generateRows!.bind(source);
    const { ctx: writeCtx, subject } = this.identity(ctx);
    const outcome = await generate(args.model, args, writeCtx);
    ctx.audit({
      target: args.model,
      summary: `generated ${outcome.inserted} row${outcome.inserted === 1 ? '' : 's'} in ${args.model}`,
      extra: {
        inserted: outcome.inserted,
        sample: outcome.sample,
        sampleCapped: outcome.sampleCapped,
        ...(subject !== undefined ? { runAsIdentity: subject } : {}),
      },
    });
    return { inserted: outcome.inserted };
  }

  /** The bound source, asserted write-capable, else `FEATURE_UNCONFIGURED`. */
  private writableSource(): StudioModelSource {
    if (!this.container.has(STUDIO_MODEL_SOURCE)) throw studioError('FEATURE_UNCONFIGURED');
    const source = this.container.resolve(STUDIO_MODEL_SOURCE);
    if (
      source.writeRow === undefined ||
      source.deleteRows === undefined ||
      source.clearTable === undefined ||
      source.generateRows === undefined
    ) {
      throw studioError('FEATURE_UNCONFIGURED', 'the bound data source is read-only');
    }
    return source;
  }

  /**
   * Resolve the write context + audit subject for this dispatch. Impersonation
   * is honored ONLY when the `identity` editable gate is open; with the gate
   * closed (or no identity configured) the write runs as the master principal
   * and no `runAsIdentity` subject is stamped.
   */
  private identity(ctx: AdminOpContext): { ctx: StudioWriteContext; subject?: string } {
    const configured = this.resolvedConfig()?.runAsIdentity;
    if (configured === undefined || !ctx.editable.identity) return { ctx: {} };
    return { ctx: { identity: configured }, subject: identitySubject(configured) };
  }

  private resolvedConfig(): ResolvedStudioConfig | undefined {
    return this.container.has(STUDIO_RESOLVED_CONFIG)
      ? this.container.resolve(STUDIO_RESOLVED_CONFIG)
      : undefined;
  }
}

/** The human confirm/audit line for a delete (e.g. "hard-delete 3 rows from users"). */
function deleteSummary(args: DeleteRowsRequest): string {
  const n = args.ids.length;
  return `${args.mode}-delete ${n} row${n === 1 ? '' : 's'} from ${args.model}`;
}

/** The audit subject for an impersonation identity (first present id field). */
function identitySubject(id: StudioRunAsIdentity): string {
  return id.userId ?? id.organizationId ?? id.tenantId ?? id.agentId ?? 'configured';
}
