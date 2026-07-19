/**
 * `@velajs/studio/cloudflare` — the CF-NATIVE time-travel tier: a
 * {@link CloudflareDoTimeTravelPort} that binds `TIME_TRAVEL_PORT` to a SQLite
 * Durable Object's point-in-time recovery (PITR) bookmarks, plus the opt-in
 * {@link StudioCloudflareTimeTravelModule} that wires it.
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
import { defineModule } from '@velajs/vela';
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

/** The op a preview mints, and armRestore re-verifies, the confirm token against. */
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
  /** The Durable Object namespace binding whose stubs expose the PITR RPC. */
  namespace: DoPitrNamespace;
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
 * `timeTravel.armRestore` + the resolved `{ bookmark }`; the dispatch registry's
 * 428 gate consumes it before `armRestore` runs. `armRestore` additionally
 * re-verifies the token STATELESSLY over `(op, args-minus-token)` — the identical
 * tuple the registry binds — so the check passes in the registry path (after the
 * single-use consume) AND fail-closes a direct call that arrives without a valid
 * confirm. Because the binding is over the whole arm payload, adding `restart` /
 * `scope` (which the preview token was NOT minted with) correctly forces a fresh
 * 428 challenge — the same widening behavior as the portable adapter.
 *
 * Marks are opaque DO bookmark strings; `undoMark.id` IS the bookmark for the
 * pre-restore state. A restore is IN-PLACE and RESTART-REQUIRED: with
 * `restart: false` (default) it is armed for the DO's next session
 * (`applied: false`); with `restart: true` the DO aborts to apply now
 * (`applied: true`). This tier has NO mark listing, snapshot creation, or
 * off-platform export (the corresponding capability booleans are `false`).
 */
export class CloudflareDoTimeTravelPort implements TimeTravelPort {
  readonly id = 'cf-do-pitr';

  private readonly namespace: DoPitrNamespace;
  private readonly confirm: ConfirmTokenSigner;
  private readonly shardKey: (scope?: TimeTravelScope) => string;

  constructor(deps: CloudflareDoTimeTravelPortDeps) {
    this.namespace = deps.namespace;
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
    // Defense in depth: the dispatch registry's 428 gate already verified +
    // consumed this token (single-use) before we run; this STATELESS re-verify
    // over the same (op, args-minus-token) tuple fail-closes a direct call and
    // re-passes idempotently in the registry path. See the class doc.
    const { confirmToken, ...payload } = req;
    const valid = await this.confirm.verify(ARM_RESTORE_OP, payload, confirmToken);
    if (!valid) throw studioError('STUDIO_CONFIRM_REQUIRED');

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
      // applied); `restart: true` aborts the DO to apply it now.
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
    return this.namespace.get(this.namespace.idFromName(name));
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
// The module
// ---------------------------------------------------------------------------

/** Options for {@link StudioCloudflareTimeTravelModule}. */
export interface StudioCloudflareTimeTravelModuleOptions {
  /** The Durable Object namespace binding whose stubs expose the PITR RPC. */
  namespace: DoPitrNamespace;
  /**
   * Maps a {@link TimeTravelScope} to the DO name (the shard). Default:
   * `scope.dataset` (the room / DO name), else `'default'`.
   */
  shardKey?: (scope?: TimeTravelScope) => string;
}

const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  defineModule<StudioCloudflareTimeTravelModuleOptions>({
    name: 'StudioCloudflareTimeTravel',
    setup: ({ OPTIONS }) => ({
      providers: [
        {
          provide: TIME_TRAVEL_PORT,
          useFactory: (
            confirm: ConfirmTokenSigner,
            options: StudioCloudflareTimeTravelModuleOptions,
          ) =>
            new CloudflareDoTimeTravelPort({
              namespace: options.namespace,
              confirm,
              ...(options.shardKey !== undefined ? { shardKey: options.shardKey } : {}),
            }),
          inject: [ConfirmTokenSigner, OPTIONS],
        },
      ],
      exports: [TIME_TRAVEL_PORT],
    }),
  });

/**
 * Binds {@link CloudflareDoTimeTravelPort} to `TIME_TRAVEL_PORT`. Import it with
 * `StudioCloudflareTimeTravelModule.forRoot({ namespace: env.ROOM })` ALONGSIDE
 * `StudioModule` in a Cloudflare app whose SQLite Durable Object extends
 * `VelaWebSocketDurableObject`. It needs no `STUDIO_MODEL_SOURCE` (unlike the
 * portable tier) — it restores the DO's own storage, not managed crud models.
 */
export class StudioCloudflareTimeTravelModule extends ConfigurableModuleClass {}
export { MODULE_OPTIONS_TOKEN as STUDIO_CLOUDFLARE_TIMETRAVEL_MODULE_OPTIONS };
