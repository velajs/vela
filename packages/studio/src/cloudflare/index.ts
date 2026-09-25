import { defineProvider } from '@velajs/vela';
import { Container, readEnv, resolveBinding, type BindingKind } from '@velajs/vela/module-kit';
/**
 * `@velajs/studio/cloudflare` — the CF-NATIVE time-travel tier: a
 * {@link CloudflareDoTimeTravelPort} that binds `TIME_TRAVEL_PORT` to a SQLite
 * Durable Object's point-in-time recovery (PITR) bookmarks, plus the opt-in
 * {@link cloudflareTimeTravelPanel} that wires it.
 *
 * This subpath is the ONLY module in the package that imports `@velajs/cloudflare`
 * (the optional-peer discipline, mirroring `@velajs/studio/crud`): the core `.`
 * entry never does, so apps without Cloudflare still mount `StudioModule` and the
 * portable snapshot tier. `@velajs/cloudflare` is imported TYPE-ONLY here — the
 * raw PITR RPC is invoked over the app-provided DO namespace binding at runtime,
 * so the built subpath has ZERO runtime coupling to `@velajs/cloudflare` (edge-
 * safe). Dependency direction is one-way: studio → cloudflare, never the reverse.
 *
 * Unlike the portable `SnapshotTimeTravelAdapter` (which captures + reloads NDJSON
 * row dumps for ANY deployment), this port restores the Durable Object's OWN
 * SQLite storage in place, on the DO's next session — no snapshots, no listing,
 * no off-platform export. The two implement the SAME frozen `TimeTravelPort`, so
 * `studio.capabilities` resolves this port's `capabilities()` exactly as it does
 * the portable one; each advertises its true powers via the capability booleans.
 */
import type {
  RestoreOutcome,
  RestorePreview,
  RestoreRequest,
  RestoreTarget,
  TimeTravelCapabilities,
  TimeTravelMark,
  TimeTravelPort,
  TimeTravelScope,
} from '@velajs/studio-protocol';
import type { DoPitrArmOptions, DoPitrNamespace, VelaDoPitrRpc } from '@velajs/cloudflare';
import { ConfirmTokenSigner } from '../security/confirm-token';
import { studioError, studioNotFound } from '../studio.errors';
import { TIME_TRAVEL_PORT } from '../timetravel/port.token';
import { defineStudioPlugin, type StudioPlugin } from '../plugin';

/** The op `preview` mints the confirm token against (the dispatch registry's 428 gate verifies it). */
const ARM_RESTORE_OP = 'timeTravel.armRestore';

/**
 * The honest scope note for a DO PITR restore. It restores the Durable Object's
 * OWN state and nothing else — the operator must understand exactly what a
 * bookmark rollback covers.
 */
const CF_SCOPE_NOTE =
  'Restores THIS Durable Object’s own SQLite-backed storage to a point-in-time ' +
  'bookmark, in place, applied on the DO’s next session (a restart). It covers the ' +
  'DO-hosted data this object owns — e.g. the @velajs/vela/live cursor log for this ' +
  'room. It does NOT restore any external store: a BYO / Postgres database, object ' +
  'storage, KV, queues, another Durable Object, or any data outside this DO are ' +
  'unaffected. PITR reaches back roughly 30 days and requires a SQLite-backed DO; a ' +
  'non-SQLite DO reports time travel unavailable.';

/** Resolve a wall-clock target to epoch ms, or `undefined` when unparseable. */
function toEpoch(time: number | string): number | undefined {
  const t = typeof time === 'number' ? time : Date.parse(time);
  return Number.isNaN(t) ? undefined : t;
}

/**
 * True when a Worker→DO RPC error signals DO PITR unavailability (a non-SQLite
 * DO). Detected structurally so this subpath keeps a TYPE-ONLY dependency on
 * `@velajs/cloudflare`: the raw capability throws a `DoPitrUnavailableError` whose
 * `code` / `name` / `message` sentinel (`'PITR_UNAVAILABLE: …'`) survive the RPC
 * hop — the contract `@velajs/cloudflare`'s `isDoPitrUnavailable` documents.
 */
function isPitrUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { code?: unknown; name?: unknown; message?: unknown };
  if (record.code === 'PITR_UNAVAILABLE') return true;
  if (record.name === 'DoPitrUnavailableError') return true;
  return typeof record.message === 'string' && record.message.startsWith('PITR_UNAVAILABLE:');
}

/** Construction dependencies for {@link CloudflareDoTimeTravelPort}. */
export interface CloudflareDoTimeTravelPortDeps {
  /**
   * The Durable Object namespace binding whose stubs expose the PITR RPC, or a
   * function that reads it when a call first needs it.
   */
  namespace: DoPitrNamespace | (() => DoPitrNamespace);
  /** The shared confirm-token signer (same instance the dispatch registry uses). */
  confirm: ConfirmTokenSigner;
  /**
   * Maps a {@link TimeTravelScope} to the DO name (the shard). Default:
   * `scope.dataset` (the room / DO name), else `'default'`.
   */
  shardKey?: (scope?: TimeTravelScope) => string;
}

/**
 * The CF-native (`id: 'cf-do-pitr'`) time-travel port. Each call resolves the DO
 * stub for the scope's shard and makes the Worker→DO RPC hop into the raw PITR
 * methods (`pitrCurrentBookmark` / `pitrBookmarkForTime` / `pitrArmRestore`).
 *
 * Confirm flow — the SAME single-use challenge as every destructive Studio op.
 * `preview` mints a {@link ConfirmTokenSigner} token bound to op
 * `timeTravel.armRestore` + the resolved `{ bookmark }`. The dispatch registry's
 * 428 gate is the SOLE gate: it verifies + single-use-consumes the `confirmToken`
 * over the ACTUALLY-DISPATCHED `(op, payload-minus-token)` BEFORE the handler
 * runs. `armRestore` does NOT re-verify — exactly like the portable
 * `SnapshotTimeTravelAdapter`. A port-level re-verify cannot be correct here: the
 * port doesn't know which op dispatched — both `timeTravel.armRestore` AND
 * `timeTravel.undo` route through this one `armRestore` method, carrying tokens
 * the registry minted for DIFFERENT (op, payload) tuples (`(armRestore,
 * { bookmark })` vs `(undo, { undoMark })`). A stateless `(armRestore, { bookmark })`
 * check would reject undo's token — AFTER the registry already consumed it —
 * permanently breaking `undo`. The registry's payload binding also handles the
 * widening case (a `restart`/`scope` the preview token was not minted with
 * correctly forces a fresh 428), so the port never needs to.
 *
 * Marks are opaque DO bookmark strings; `undoMark.id` IS the bookmark for the
 * pre-restore state. A restore is IN-PLACE and RESTART-REQUIRED: with
 * `restart: false` (default) it is armed for the DO's next session
 * (`applied: false`) and the caller receives this outcome incl. the `undoMark`.
 * With `restart: true` the DO aborts to apply NOW — `ctx.abort` severs the
 * in-flight RPC, so the caller CANNOT actually receive the returned `undoMark`
 * (or `applied: true`); `restart: false` is the confirmable, undo-mark-returning
 * path and `restart: true` is fire-and-forget. This tier has NO mark listing,
 * snapshot creation, or off-platform export (the capability booleans are `false`).
 */
export class CloudflareDoTimeTravelPort implements TimeTravelPort {
  readonly id = 'cf-do-pitr';

  readonly #namespace: () => DoPitrNamespace;
  private readonly confirm: ConfirmTokenSigner;
  private readonly shardKey: (scope?: TimeTravelScope) => string;

  constructor(deps: CloudflareDoTimeTravelPortDeps) {
    const { namespace } = deps;
    this.#namespace = typeof namespace === 'function' ? namespace : () => namespace;
    this.confirm = deps.confirm;
    this.shardKey = deps.shardKey ?? ((scope) => scope?.dataset ?? 'default');
  }

  capabilities(_scope?: TimeTravelScope): TimeTravelCapabilities {
    return {
      markByTime: true,
      list: false,
      undo: true,
      inPlace: true,
      restartRequired: true,
      portableExport: false,
      createOnDemand: false,
      granularity: 'bookmark',
      scopeNote: CF_SCOPE_NOTE,
    };
  }

  async getCurrentMark(scope?: TimeTravelScope): Promise<TimeTravelMark> {
    const read = await this.run(() => this.stubFor(scope).pitrCurrentBookmark());
    return { id: read.current, kind: 'bookmark' };
  }

  async getMarkForTime(
    time: number | string,
    scope?: TimeTravelScope,
  ): Promise<TimeTravelMark | null> {
    const read = await this.run(() => this.stubFor(scope).pitrBookmarkForTime(time));
    if (read.forTime === undefined) return null;
    const epoch = toEpoch(time);
    return { id: read.forTime, kind: 'bookmark', ...(epoch !== undefined ? { time: epoch } : {}) };
  }

  async preview(target: RestoreTarget, scope?: TimeTravelScope): Promise<RestorePreview> {
    const stub = this.stubFor(scope);
    const { bookmark, markTime } = await this.resolveTarget(stub, target);
    const { token, exp } = await this.confirm.issue(ARM_RESTORE_OP, { bookmark });
    return {
      target: {
        id: bookmark,
        kind: 'bookmark',
        ...(markTime !== undefined ? { time: markTime } : {}),
      },
      // DO PITR restores the whole DO storage, not a per-table selection — there
      // is no honest per-table row estimate to surface (see `scopeNote`).
      affectedTables: [],
      schemaCompatible: true,
      incompatibleTables: [],
      undoAvailable: true,
      restartRequired: true,
      confirmToken: token,
      expiresAt: exp * 1000,
    };
  }

  async armRestore(req: RestoreRequest): Promise<RestoreOutcome> {
    // The confirm token was already verified + single-use-consumed by the dispatch
    // registry's 428 gate over the ACTUALLY-DISPATCHED (op, payload) — for BOTH
    // `timeTravel.armRestore` and `timeTravel.undo`, which route here. The port
    // does NOT re-verify: it cannot know the dispatched op name (arm vs undo both
    // call this method), so a port-level `(armRestore, { bookmark })` check would
    // reject undo's `(undo, { undoMark })` token. The registry owns the gate —
    // exactly as the portable `SnapshotTimeTravelAdapter` relies on it. See the
    // class doc.
    const restart = req.restart === true;
    const opts: DoPitrArmOptions = {
      ...(req.bookmark !== undefined ? { bookmark: req.bookmark } : {}),
      ...(req.time !== undefined ? { time: req.time } : {}),
      restart,
    };
    const result = await this.run(() => this.stubFor(req.scope).pitrArmRestore(opts));
    return {
      restoredTo: result.restoredTo,
      undoMark: { id: result.undoBookmark, kind: 'bookmark' },
      // `restart: false` arms the restore for the DO's next session (not yet
      // applied) and returns this outcome, incl. the `undoMark`, to the caller.
      // `restart: true` aborts the DO to apply NOW — `ctx.abort` severs the RPC,
      // so the caller does not actually receive this `applied: true` / `undoMark`;
      // the confirmable, undo-returning path is `restart: false`.
      applied: restart,
      restartRequested: restart,
    };
  }

  /** Resolve a restore target to a concrete bookmark (an explicit bookmark wins over a time). */
  private async resolveTarget(
    stub: VelaDoPitrRpc,
    target: RestoreTarget,
  ): Promise<{ bookmark: string; markTime?: number }> {
    if (target.bookmark !== undefined) return { bookmark: target.bookmark };
    if (target.time !== undefined) {
      const read = await this.run(() => stub.pitrBookmarkForTime(target.time!));
      if (read.forTime === undefined) {
        throw studioNotFound('no Durable Object PITR bookmark at or before the requested time');
      }
      const markTime = toEpoch(target.time);
      return { bookmark: read.forTime, ...(markTime !== undefined ? { markTime } : {}) };
    }
    throw studioNotFound('a restore target (bookmark or time) is required');
  }

  /** The PITR RPC stub for the scope's shard (DO name). */
  private stubFor(scope?: TimeTravelScope): VelaDoPitrRpc {
    const name = this.shardKey(scope);
    const namespace = this.#namespace();
    return namespace.get(namespace.idFromName(name));
  }

  /** Run an RPC call, mapping a DO-PITR-unavailable error to `TIMETRAVEL_UNAVAILABLE` (409). */
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (isPitrUnavailable(error)) throw studioError('TIMETRAVEL_UNAVAILABLE');
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/** A Durable Object namespace whose stubs expose the PITR RPC. */
const PITR_NAMESPACE: BindingKind<DoPitrNamespace> = {
  name: 'Durable Object namespace',
  configKey: 'durable_objects.bindings',
  accepts: (value): value is DoPitrNamespace =>
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'idFromName') === 'function' &&
    typeof Reflect.get(value, 'get') === 'function',
};

/** Options for {@link cloudflareTimeTravelPanel}. */
export interface CloudflareTimeTravelPanelOptions {
  /**
   * The Durable Object namespace binding whose stubs expose the PITR RPC, read
   * from each application's `ENV` when a time-travel call first needs it.
   */
  binding: string;
  /**
   * Maps a {@link TimeTravelScope} to the DO name (the shard). Default:
   * `scope.dataset` (the room / DO name), else `'default'`.
   */
  shardKey?: (scope?: TimeTravelScope) => string;
}

/**
 * Binds {@link CloudflareDoTimeTravelPort} to `TIME_TRAVEL_PORT` in a Cloudflare
 * app whose SQLite Durable Object extends `VelaWebSocketDurableObject`:
 * `StudioModule.forRoot({ plugins: [cloudflareTimeTravelPanel({ binding: 'ROOM' })] })`.
 * It needs no `STUDIO_MODEL_SOURCE` (unlike the portable tier) — it restores
 * the DO's own storage, not managed crud models.
 */
export function cloudflareTimeTravelPanel(options: CloudflareTimeTravelPanelOptions): StudioPlugin {
  const { binding, shardKey } = options;
  if (typeof binding !== 'string' || binding.length === 0) {
    throw new TypeError(
      'cloudflareTimeTravelPanel needs the { binding } of its Durable Object namespace.',
    );
  }
  return defineStudioPlugin({
    name: 'cloudflare-time-travel',
    providers: [
      defineProvider(TIME_TRAVEL_PORT, {
        useFactory: (confirm: ConfirmTokenSigner, container: Container) =>
          new CloudflareDoTimeTravelPort({
            namespace: () => resolveBinding(readEnv(container), { binding }, PITR_NAMESPACE),
            confirm,
            ...(shardKey !== undefined ? { shardKey } : {}),
          }),
        inject: [ConfirmTokenSigner, Container],
      }),
    ],
  });
}
