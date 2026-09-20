/**
 * `SnapshotTimeTravelAdapter` — the portable (`id: 'portable-snapshot'`) tier of
 * data time-travel. It works on ANY deployment: it captures each managed crud
 * model to an NDJSON row dump plus a {@link SnapshotManifest} (with a per-table
 * `schemaHash`), and restores by truncating + reloading those tables. The CF-DO
 * PITR bookmark adapter (M11) is the runtime-native alternative.
 *
 * Streaming discipline: `createSnapshot` NEVER buffers a whole table — rows are
 * paged out of the {@link StudioModelSource} one page at a time through a pull-
 * based `ReadableStream`, and restore reads the NDJSON back line-by-line. The
 * only in-memory concentration is inside the {@link SnapshotStore} impl (the
 * in-memory store holds bytes by design; the fs/R2 impls stream to disk/object
 * storage).
 *
 * Confirm flow (the SAME single-use challenge as every destructive Studio op):
 * `preview` mints a {@link ConfirmTokenSigner} token bound to op
 * `timeTravel.armRestore` and the arming payload `{ bookmark }` — OR, when this
 * adapter is CDC-capable (`snapshot+cdc`) and the preview addressed a mid-window
 * `time`, the payload `{ bookmark, time }`. That second form is what makes CDC
 * reachable THROUGH preview→arm: the previewed token authorizes a reload-base-
 * snapshot-then-replay-CDC-up-to-`time` restore, instead of collapsing to the
 * snapshot boundary and losing CDC precision (`RestoreRequest` already carries
 * both fields — no wire change). The UI's preview→arm step rides straight
 * through the dispatch registry's 428 gate (which consumes it); the adapter does
 * NOT re-verify — the registry owns that. Because the confirm is payload-bound,
 * arming with a `force`/`scope` the preview token was NOT minted with fails
 * verification and (correctly) yields a fresh 428 challenge.
 *
 * Restore is IN-PLACE + immediate (`applied: true`, `restartRequested: false`),
 * captures an undo snapshot of the pre-restore state FIRST (returned as
 * `undoMark`), and — when a {@link ChangeSource} is bound — replays audit-backed
 * changes to reach a mid-window point in time (`granularity: 'snapshot+cdc'`).
 * The restore is NOT atomic across tables (this portable tier has no cross-table
 * transaction): a mid-restore failure can leave tables partially applied, so it
 * throws an error carrying the pre-captured `undoMark` id (the recovery target).
 */
import type {
  RestoreOutcome,
  RestorePreview,
  RestoreRequest,
  RestoreTarget,
  RetentionPolicy,
  SnapshotManifest,
  StudioChange,
  TimeTravelCapabilities,
  TimeTravelMark,
  TimeTravelMarkPage,
  TimeTravelPort,
  TimeTravelScope,
} from '@velajs/studio-protocol';
import { ConfirmTokenSigner } from '../security/confirm-token';
import { utf8 } from '../security/crypto';
import { studioError, studioNotFound, studioRestoreInterrupted } from '../studio.errors';
import type { StudioModelSource, StudioWriteContext } from '../data/model-source.port';
import type { SnapshotStore } from './snapshot-store.port';
import type { ChangeSource } from './change-source.port';
import type { LiveInvalidatorPort } from './live-invalidation';
import { NoopLiveInvalidator } from './live-invalidation';
import { combinedSchemaHash, schemaHashForColumns } from './schema-hash';

/** Construction dependencies for {@link SnapshotTimeTravelAdapter}. */
export interface SnapshotAdapterDeps {
  /** Where NDJSON dumps + manifests live. */
  store: SnapshotStore;
  /** The managed-model row source (crud-backed, or a BYO write-capable source). */
  source: StudioModelSource;
  /** The shared confirm-token signer (same instance the dispatch registry uses). */
  confirm: ConfirmTokenSigner;
  /** Fired after a successful restore to re-snapshot live queries. Default: no-op. */
  live?: LiveInvalidatorPort;
  /** OPTIONAL audit-backed CDC seam; presence upgrades granularity to `snapshot+cdc`. */
  changeSource?: ChangeSource;
  /** Injectable clock (epoch ms) for deterministic tests. Default `Date.now`. */
  now?: () => number;
  /** Rows pulled per page while streaming a snapshot. Default 500. */
  perPage?: number;
}

const ADAPTER_ID = 'portable-snapshot';
const MANIFEST_PREFIX = 'manifests/';
const HEAD_MARK_ID = 'head';
const DEFAULT_PER_PAGE = 500;
const DEFAULT_MARK_LIMIT = 50;

const SCOPE_NOTE =
  'Restores the managed crud models (row data only) captured in the snapshot. ' +
  'External stores (object storage, queues, caches, third-party systems) and any ' +
  'tables not managed by Studio are NOT affected. A portable restore is NOT atomic ' +
  'across tables (this tier has no cross-table transaction): if it fails partway, ' +
  'recover by restoring to the undo mark it returns as `undoMark` — the same id is ' +
  'surfaced on the failure error details.';

const manifestKey = (id: string): string => `${MANIFEST_PREFIX}${id}.json`;
const ndjsonKey = (id: string, table: string): string => `snapshots/${id}/${table}.ndjson`;

/** Normalize an epoch-ms number or ISO string to epoch ms (`NaN` when unparseable). */
function toEpoch(time: number | string): number {
  return typeof time === 'number' ? time : Date.parse(time);
}

export class SnapshotTimeTravelAdapter implements TimeTravelPort {
  readonly id = ADAPTER_ID;

  private readonly store: SnapshotStore;
  private readonly source: StudioModelSource;
  private readonly confirm: ConfirmTokenSigner;
  private readonly live: LiveInvalidatorPort;
  private readonly changeSource?: ChangeSource;
  private readonly clock: () => number;
  private readonly perPage: number;

  constructor(deps: SnapshotAdapterDeps) {
    this.store = deps.store;
    this.source = deps.source;
    this.confirm = deps.confirm;
    this.live = deps.live ?? new NoopLiveInvalidator();
    this.changeSource = deps.changeSource;
    this.clock = deps.now ?? (() => Date.now());
    this.perPage = deps.perPage && deps.perPage > 0 ? deps.perPage : DEFAULT_PER_PAGE;
  }

  capabilities(_scope?: TimeTravelScope): TimeTravelCapabilities {
    return {
      markByTime: true,
      list: true,
      undo: true,
      inPlace: true,
      restartRequired: false,
      portableExport: true,
      createOnDemand: true,
      granularity: this.changeSource !== undefined ? 'snapshot+cdc' : 'snapshot',
      scopeNote: SCOPE_NOTE,
    };
  }

  async getCurrentMark(_scope?: TimeTravelScope): Promise<TimeTravelMark> {
    const manifests = await this.listManifests();
    const latest = manifests[0];
    if (latest === undefined) return { id: HEAD_MARK_ID, kind: 'snapshot', time: this.clock() };
    return this.manifestToMark(latest);
  }

  async getMarkForTime(
    time: number | string,
    _scope?: TimeTravelScope,
  ): Promise<TimeTravelMark | null> {
    const t = toEpoch(time);
    if (Number.isNaN(t)) return null;
    const manifest = await this.latestAtOrBefore(t);
    return manifest === null ? null : this.manifestToMark(manifest);
  }

  async listMarks(
    _scope?: TimeTravelScope,
    opts?: { limit?: number; before?: string },
  ): Promise<TimeTravelMarkPage> {
    const manifests = await this.listManifests();
    let start = 0;
    if (opts?.before !== undefined) {
      const at = manifests.findIndex((m) => m.id === opts.before);
      start = at >= 0 ? at + 1 : manifests.length;
    }
    const limit = opts?.limit !== undefined && opts.limit > 0 ? opts.limit : DEFAULT_MARK_LIMIT;
    const slice = manifests.slice(start, start + limit);
    const marks = await Promise.all(slice.map((m) => this.manifestToMark(m)));
    const last = slice.at(-1);
    const hasMore = start + limit < manifests.length && last !== undefined;
    return hasMore ? { marks, nextCursor: last.id } : { marks };
  }

  async preview(target: RestoreTarget, _scope?: TimeTravelScope): Promise<RestorePreview> {
    const manifest = await this.resolveTarget(target);
    const incompatibleTables = await this.incompatibleTables(manifest);
    const { token, exp } = await this.confirm.issue(
      'timeTravel.armRestore',
      this.armPayloadFor(target, manifest),
    );
    return {
      target: await this.manifestToMark(manifest),
      affectedTables: manifest.tables.map((t) => ({ table: t.table, approxRows: t.rows })),
      schemaCompatible: incompatibleTables.length === 0,
      incompatibleTables,
      undoAvailable: true,
      restartRequired: false,
      confirmToken: token,
      expiresAt: exp * 1000,
    };
  }

  async armRestore(req: RestoreRequest): Promise<RestoreOutcome> {
    // NOTE: the confirm token was already verified + consumed by the dispatch
    // registry's 428 gate (op `timeTravel.armRestore`); the adapter does not
    // re-verify — it owns only the restore itself.
    const manifest = await this.resolveTarget(req);
    const incompatible = await this.incompatibleTables(manifest);
    if (incompatible.length > 0 && req.force !== true) {
      throw studioError(
        'TIMETRAVEL_SCHEMA_MISMATCH',
        `snapshot schema no longer matches current schema for: ${incompatible.join(', ')}`,
      );
    }

    // Capture the pre-restore state FIRST so the restore is reversible. Its id
    // is the ONLY recovery handle if the (non-atomic, cross-table) restore below
    // fails partway, so it is captured BEFORE the loop and surfaced on failure.
    const undoMark = await this.createSnapshot({
      ...(req.scope !== undefined ? { scope: req.scope } : {}),
      label: `undo before restore to ${manifest.id}`,
    });

    try {
      for (const table of manifest.tables) {
        await this.restoreTable(table.table, manifest.id);
      }

      const replayTo = this.cdcTargetTime(req, manifest);
      if (replayTo !== null && this.changeSource !== undefined) {
        await this.replayChanges(manifest, replayTo, req.scope);
      }
    } catch (cause) {
      // Portable tier has NO cross-table transaction, so a throw here can leave
      // tables partially applied. Surface the undo mark id (the recovery target)
      // on the error so the client + audit can restore to it; the underlying
      // failure rides as `cause` (server logs only, never echoed to the client).
      throw studioRestoreInterrupted(undoMark.id, cause);
    }

    await this.live.invalidateTables(this.tableNamesFor(manifest));

    return { restoredTo: manifest.id, undoMark, applied: true, restartRequested: false };
  }

  /**
   * Capture every managed model to an NDJSON dump + a manifest. NOTE (portable-
   * tier limitation): each table is paged out by OFFSET (`page`/`perPage`), so a
   * snapshot taken WHILE the source is being written is NOT guaranteed point-in-
   * time-consistent — concurrent inserts/deletes shift the offset window and can
   * duplicate or skip rows across page boundaries. Snapshot from a quiesced
   * source, or use a runtime-native PITR adapter, when cross-row consistency
   * under concurrent writes is required.
   */
  async createSnapshot(opts?: {
    scope?: TimeTravelScope;
    label?: string;
  }): Promise<TimeTravelMark> {
    const createdAt = this.clock();
    const id = this.newId(createdAt);
    const tables: SnapshotManifest['tables'] = [];
    for (const info of this.source.listModels()) {
      const model = info.name;
      const schemaHash = await schemaHashForColumns(this.source.describe(model).columns);
      const key = ndjsonKey(id, model);
      const counter = { rows: 0 };
      await this.store.putStream(key, this.rowsNdjson(model, counter));
      tables.push({ table: model, rows: counter.rows, schemaHash, ndjsonKey: key });
    }
    const manifest: SnapshotManifest = {
      id,
      createdAt,
      ...(opts?.label !== undefined ? { label: opts.label } : {}),
      tables,
    };
    await this.store.putJson(manifestKey(id), manifest);
    return this.manifestToMark(manifest);
  }

  async exportSnapshot(markId: string): Promise<ReadableStream<Uint8Array>> {
    const manifest = await this.store.getJson<SnapshotManifest>(manifestKey(markId));
    if (manifest === null) throw studioNotFound(`snapshot '${markId}' not found`);
    const chunks = this.exportChunks(manifest);
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await chunks.next();
        if (done || value === undefined) controller.close();
        else controller.enqueue(value);
      },
    });
  }

  async prune(retention: RetentionPolicy, _scope?: TimeTravelScope): Promise<{ pruned: number }> {
    if (retention.keepLast === undefined && retention.maxAgeMs === undefined) return { pruned: 0 };
    const manifests = await this.listManifests(); // newest first
    const keep = new Set<string>();
    if (retention.keepLast !== undefined) {
      for (const m of manifests.slice(0, Math.max(0, retention.keepLast))) keep.add(m.id);
    }
    if (retention.maxAgeMs !== undefined) {
      const cutoff = this.clock() - retention.maxAgeMs;
      for (const m of manifests) if (m.createdAt >= cutoff) keep.add(m.id);
    }
    let pruned = 0;
    for (const m of manifests) {
      if (keep.has(m.id)) continue;
      for (const t of m.tables) await this.store.delete(t.ndjsonKey);
      await this.store.delete(manifestKey(m.id));
      pruned += 1;
    }
    return { pruned };
  }

  // -- snapshot streaming ----------------------------------------------------

  /**
   * A pull-based NDJSON stream of every row of `model`. Pages the source
   * `perPage` rows at a time (incl. soft-deleted, for a faithful restore) so at
   * most ONE page is resident — a whole table is never buffered. Increments
   * `counter.rows` so the caller can record the exact row count in the manifest.
   */
  private rowsNdjson(model: string, counter: { rows: number }): ReadableStream<Uint8Array> {
    const source = this.source;
    const perPage = this.perPage;
    let page = 1;
    let finished = false;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (finished) {
          controller.close();
          return;
        }
        const result = await source.list(model, { model, page, perPage, withDeleted: true });
        const rows = result.rows;
        if (rows.length === 0) {
          finished = true;
          controller.close();
          return;
        }
        let buf = '';
        for (const row of rows) {
          buf += `${JSON.stringify(row)}\n`;
          counter.rows += 1;
        }
        controller.enqueue(utf8(buf));
        if (result.info.has_next_page === true && rows.length >= perPage) page += 1;
        else {
          finished = true;
          controller.close();
        }
      },
    });
  }

  private async *exportChunks(manifest: SnapshotManifest): AsyncGenerator<Uint8Array> {
    yield utf8(`${JSON.stringify({ manifest })}\n`);
    for (const t of manifest.tables) {
      yield utf8(`${JSON.stringify({ table: t.table, schemaHash: t.schemaHash })}\n`);
      const stream = await this.store.getStream(t.ndjsonKey);
      if (stream === null) continue;
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) yield value;
      }
    }
  }

  // -- restore ---------------------------------------------------------------

  /** Truncate `model` then reload it row-by-row from the snapshot's NDJSON. */
  private async restoreTable(model: string, snapshotId: string): Promise<void> {
    const source = this.source;
    const clearTable = source.clearTable?.bind(source);
    const writeRow = source.writeRow?.bind(source);
    if (clearTable === undefined || writeRow === undefined) {
      throw studioError(
        'FEATURE_UNCONFIGURED',
        'the bound data source is read-only; time-travel restore needs a write-capable source',
      );
    }
    const ctx: StudioWriteContext = {};
    await clearTable(model, { model, confirmToken: '' }, ctx);
    const stream = await this.store.getStream(ndjsonKey(snapshotId, model));
    if (stream === null) return;
    // Create-path writeRow preserves the row's own pk + timestamps (they are
    // present in the image), so a restore is byte-faithful — no re-stamping.
    for await (const row of readNdjson(stream)) {
      await writeRow(model, { model, patch: row }, ctx);
    }
  }

  /**
   * The epoch time a restore must replay CDC up to, or null when there is no
   * mid-window replay to do. Any `time` later than the base snapshot triggers
   * replay — INCLUDING a request that ALSO pins an explicit base `bookmark`
   * (the preview→arm CDC path mints `{ bookmark, time }`, so the arm reloads the
   * pinned base then replays up to `time`). A bookmark-only request (e.g. undo)
   * carries no `time` and so never replays. Replay is a no-op regardless unless
   * a change source is bound (guarded in `armRestore`).
   */
  private cdcTargetTime(req: RestoreRequest, manifest: SnapshotManifest): number | null {
    if (req.time === undefined) return null; // explicit-mark / bookmark-only → no replay
    const t = toEpoch(req.time);
    if (Number.isNaN(t)) return null;
    return t > manifest.createdAt ? t : null;
  }

  /** Replay audit-backed changes in `(manifest.createdAt, toTs]` onto the reloaded tables. */
  private async replayChanges(
    manifest: SnapshotManifest,
    toTs: number,
    scope?: TimeTravelScope,
  ): Promise<void> {
    const changeSource = this.changeSource;
    if (changeSource === undefined) return;
    const modelToTable = this.modelTableMap();
    for (const t of manifest.tables) {
      const model = t.table;
      const tableName = modelToTable.get(model) ?? model;
      const changes = await changeSource.changesBetween(tableName, manifest.createdAt, toTs, scope);
      const pk = this.pkField(model);
      for (const change of changes) await this.applyChange(model, pk, change);
    }
  }

  /** Apply a single CDC record to the live store (insert/update upsert, delete). */
  private async applyChange(model: string, pk: string, change: StudioChange): Promise<void> {
    const source = this.source;
    const writeRow = source.writeRow?.bind(source);
    if (writeRow === undefined) return;
    if (change.kind === 'delete') {
      const id = change.key[pk] ?? change.before?.[pk];
      const deleteRows = source.deleteRows?.bind(source);
      if (id !== undefined && deleteRows !== undefined) {
        await deleteRows(model, { model, ids: [String(id)], mode: 'hard', confirmToken: '' }, {});
      }
      return;
    }
    const after = change.after;
    if (after === undefined) return;
    const id = after[pk] ?? change.key[pk];
    const exists = id !== undefined && (await source.readOne(model, String(id))) !== null;
    await writeRow(
      model,
      exists ? { model, id: String(id), patch: after } : { model, patch: after },
      {},
    );
  }

  // -- manifest + mark helpers ----------------------------------------------

  private async resolveTarget(target: RestoreTarget): Promise<SnapshotManifest> {
    if (target.bookmark !== undefined) {
      const manifest = await this.store.getJson<SnapshotManifest>(manifestKey(target.bookmark));
      if (manifest === null) throw studioNotFound(`snapshot '${target.bookmark}' not found`);
      return manifest;
    }
    if (target.time !== undefined) {
      const t = toEpoch(target.time);
      const manifest = Number.isNaN(t) ? null : await this.latestAtOrBefore(t);
      if (manifest === null) throw studioNotFound('no snapshot at or before the requested time');
      return manifest;
    }
    throw studioNotFound('a restore target (bookmark or time) is required');
  }

  private async latestAtOrBefore(t: number): Promise<SnapshotManifest | null> {
    const manifests = await this.listManifests(); // newest first
    return manifests.find((m) => m.createdAt <= t) ?? null;
  }

  /** Manifest table names that no longer match the current model schema (or are gone). */
  private async incompatibleTables(manifest: SnapshotManifest): Promise<string[]> {
    const out: string[] = [];
    for (const t of manifest.tables) {
      let current: string | null = null;
      try {
        current = await schemaHashForColumns(this.source.describe(t.table).columns);
      } catch {
        current = null; // model no longer exists → incompatible
      }
      if (current === null || current !== t.schemaHash) out.push(t.table);
    }
    return out;
  }

  private async listManifests(): Promise<SnapshotManifest[]> {
    const keys = await this.store.list(MANIFEST_PREFIX);
    const manifests: SnapshotManifest[] = [];
    for (const key of keys) {
      const manifest = await this.store.getJson<SnapshotManifest>(key);
      if (manifest !== null) manifests.push(manifest);
    }
    return manifests.toSorted((a, b) =>
      b.createdAt !== a.createdAt ? b.createdAt - a.createdAt : a.id < b.id ? 1 : -1,
    );
  }

  private async manifestToMark(manifest: SnapshotManifest): Promise<TimeTravelMark> {
    const schemaHash = await combinedSchemaHash(manifest.tables);
    return {
      id: manifest.id,
      kind: 'snapshot',
      time: manifest.createdAt,
      ...(manifest.label !== undefined ? { label: manifest.label } : {}),
      schemaHash,
      tables: manifest.tables.map((t) => t.table),
    };
  }

  /**
   * The confirm payload `preview` mints its token over. Normally just the
   * resolved base `{ bookmark }`. When this adapter is CDC-capable
   * (`snapshot+cdc`) AND the preview addressed a mid-window `time` (a pure time
   * target, no explicit bookmark), the payload ALSO carries that `time`, so the
   * previewed arm re-sends `{ bookmark, time }` and reaches the exact point in
   * time via CDC replay instead of collapsing to the snapshot boundary. The
   * snapshot-only path (no change source) keeps collapsing to `{ bookmark }`.
   */
  private armPayloadFor(
    target: RestoreTarget,
    manifest: SnapshotManifest,
  ): { bookmark: string } | { bookmark: string; time: number | string } {
    if (
      this.changeSource !== undefined &&
      target.time !== undefined &&
      target.bookmark === undefined
    ) {
      return { bookmark: manifest.id, time: target.time };
    }
    return { bookmark: manifest.id };
  }

  private modelTableMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const info of this.source.listModels()) map.set(info.name, info.table);
    return map;
  }

  private tableNamesFor(manifest: SnapshotManifest): string[] {
    const map = this.modelTableMap();
    return manifest.tables.map((t) => map.get(t.table) ?? t.table);
  }

  private pkField(model: string): string {
    try {
      return this.source.describe(model).primaryKeys[0] ?? 'id';
    } catch {
      return 'id';
    }
  }

  private newId(createdAt: number): string {
    return `snap-${createdAt}-${crypto.randomUUID().slice(0, 8)}`;
  }
}

/** Parse an NDJSON byte stream line-by-line without buffering the whole payload. */
async function* readNdjson(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (value !== undefined) buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.length > 0) yield JSON.parse(line) as Record<string, unknown>;
      nl = buf.indexOf('\n');
    }
    if (done) break;
  }
  const tail = buf.trim();
  if (tail.length > 0) yield JSON.parse(tail) as Record<string, unknown>;
}
