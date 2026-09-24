import { describe, expect, it } from 'vitest';
import { Module, VelaFactory } from '@velajs/vela';
import { ConfirmTokenSigner, StudioModule, TIME_TRAVEL_PORT } from '../src';
import type { StudioConfirmChallenge, StudioModuleOptions } from '../src';
import { CloudflareDoTimeTravelPort, cloudflareTimeTravelPanel } from '../src/cloudflare';
// TYPE-ONLY: importing a VALUE from `@velajs/cloudflare` would pull its
// `cloudflare:workers` runtime module (workerd-only), which studio's node/vitest
// cannot load — the same edge-coupling the subpath itself avoids. The unavailable
// error is reconstructed here as the shape that survives the Worker→DO RPC hop.
import type {
  DoPitrArmOptions,
  DoPitrArmResult,
  DoPitrBookmarkRead,
  DoPitrId,
  DoPitrNamespace,
  VelaDoPitrRpc,
} from '@velajs/cloudflare';
import type {
  AdminRpcResponse,
  RestoreOutcome,
  RestorePreview,
  StudioOp,
  StudioOpReq,
  StudioOpRes,
} from '@velajs/studio-protocol';

// ===========================================================================
// A fake PITR-capable Durable Object stub + namespace (spies the 3 RPC methods).
// No real DO is needed — the raw DO PITR path is tested in the cloudflare repo;
// here the worker→DO RPC hop is faked so the port logic is exercised in isolation.
// ===========================================================================

interface FakeStubOptions {
  current?: string;
  forTime?: string | null; // null → the DO has no bookmark for that time
  undo?: string;
  unavailable?: boolean; // simulate a non-SQLite DO (post-RPC-hop error shape)
}

class FakePitrStub implements VelaDoPitrRpc {
  currentCalls = 0;
  readonly forTimeCalls: Array<number | string> = [];
  readonly armCalls: DoPitrArmOptions[] = [];

  constructor(private readonly opts: FakeStubOptions = {}) {}

  private guard(): void {
    if (this.opts.unavailable !== true) return;
    // Mimic the shape that survives the Worker→DO RPC hop: `instanceof` is lost,
    // only `name` + the `PITR_UNAVAILABLE:` message sentinel remain.
    throw Object.assign(new Error('PITR_UNAVAILABLE: no SQLite backend'), {
      name: 'DoPitrUnavailableError',
    });
  }

  pitrCurrentBookmark(): Promise<DoPitrBookmarkRead> {
    this.guard();
    this.currentCalls += 1;
    return Promise.resolve({ current: this.opts.current ?? 'bm-current' });
  }

  pitrBookmarkForTime(time: number | string): Promise<DoPitrBookmarkRead> {
    this.guard();
    this.forTimeCalls.push(time);
    const forTime = this.opts.forTime === undefined ? 'bm-for-time' : this.opts.forTime;
    return Promise.resolve({
      current: this.opts.current ?? 'bm-current',
      ...(forTime !== null ? { forTime } : {}),
    });
  }

  pitrArmRestore(opts: DoPitrArmOptions): Promise<DoPitrArmResult> {
    this.guard();
    this.armCalls.push(opts);
    return Promise.resolve({
      restoredTo: opts.bookmark ?? this.opts.forTime ?? 'bm-resolved',
      undoBookmark: this.opts.undo ?? 'bm-undo',
      restarted: opts.restart === true,
    });
  }
}

class FakePitrNamespace implements DoPitrNamespace {
  readonly names: string[] = [];
  constructor(private readonly stub: FakePitrStub) {}
  idFromName(name: string): DoPitrId {
    this.names.push(name);
    return { toString: () => `id:${name}`, name };
  }
  get(_id: DoPitrId): VelaDoPitrRpc {
    return this.stub;
  }
}

function makePort(
  opts: FakeStubOptions = {},
  extra: { confirm?: ConfirmTokenSigner; shardKey?: (scope?: { dataset?: string }) => string } = {},
): {
  port: CloudflareDoTimeTravelPort;
  stub: FakePitrStub;
  namespace: FakePitrNamespace;
  confirm: ConfirmTokenSigner;
} {
  const stub = new FakePitrStub(opts);
  const namespace = new FakePitrNamespace(stub);
  const confirm = extra.confirm ?? new ConfirmTokenSigner('cf-pitr-secret');
  const port = new CloudflareDoTimeTravelPort({
    namespace,
    confirm,
    ...(extra.shardKey !== undefined ? { shardKey: extra.shardKey } : {}),
  });
  return { port, stub, namespace, confirm };
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

// ===========================================================================
// Port-level tests (fake DO stub)
// ===========================================================================

describe('CloudflareDoTimeTravelPort — capabilities', () => {
  it('advertises the CF-native DO PITR shape (in-place, restart-required, bookmark granularity)', () => {
    const caps = makePort().port.capabilities();
    expect(caps).toEqual({
      markByTime: true,
      list: false,
      undo: true,
      inPlace: true,
      restartRequired: true,
      portableExport: false,
      createOnDemand: false,
      granularity: 'bookmark',
      scopeNote: caps.scopeNote,
    });
  });

  it('the scopeNote is honest: it restores the DO’s own SQLite state, NOT an external/Postgres store', () => {
    const note = makePort().port.capabilities().scopeNote;
    expect(note).toMatch(/Durable Object/i);
    expect(note).toMatch(/SQLite/i);
    expect(note).toMatch(/does NOT restore/i);
    expect(note).toMatch(/Postgres/i);
  });

  it('omits the optional listing / snapshot / export methods (capability booleans are false)', () => {
    const port = makePort().port;
    // `list: false` / `createOnDemand: false` / `portableExport: false` are backed
    // by the absence of the optional port methods (the ops report FEATURE_UNCONFIGURED).
    const surface = port as unknown as Record<string, unknown>;
    expect(surface.listMarks).toBeUndefined();
    expect(surface.createSnapshot).toBeUndefined();
    expect(surface.exportSnapshot).toBeUndefined();
    expect(surface.prune).toBeUndefined();
    // The required + markByTime methods ARE present.
    expect(typeof port.getCurrentMark).toBe('function');
    expect(typeof port.getMarkForTime).toBe('function');
  });
});

describe('CloudflareDoTimeTravelPort — mark reads over the RPC hop', () => {
  it('maps the current bookmark to a mark', async () => {
    const { port, stub } = makePort({ current: 'bm-now' });
    expect(await port.getCurrentMark()).toEqual({ id: 'bm-now', kind: 'bookmark' });
    expect(stub.currentCalls).toBe(1);
  });

  it('maps a by-time bookmark to a mark (and null when the DO has none)', async () => {
    const present = makePort({ forTime: 'bm-T' });
    expect(await present.port.getMarkForTime(1500)).toEqual({
      id: 'bm-T',
      kind: 'bookmark',
      time: 1500,
    });
    expect(present.stub.forTimeCalls).toEqual([1500]);

    const absent = makePort({ forTime: null });
    expect(await absent.port.getMarkForTime(1500)).toBeNull();
  });

  it('routes to the scope’s DO shard via the shard-key resolver', async () => {
    const { port, namespace } = makePort({ current: 'bm-x' });
    await port.getCurrentMark({ dataset: 'room-42' });
    expect(namespace.names).toEqual(['room-42']);

    const custom = makePort(
      { current: 'bm-y' },
      { shardKey: (scope) => `shard:${scope?.dataset ?? 'main'}` },
    );
    await custom.port.getCurrentMark({ dataset: 'orders' });
    expect(custom.namespace.names).toEqual(['shard:orders']);
  });
});

describe('CloudflareDoTimeTravelPort — preview mints the confirm token', () => {
  it('resolves a bookmark target and mints a token bound to (armRestore op, { bookmark })', async () => {
    const { port, confirm } = makePort();
    const preview = await port.preview({ bookmark: 'bm-A' });

    expect(preview.target).toEqual({ id: 'bm-A', kind: 'bookmark' });
    expect(preview.restartRequired).toBe(true);
    expect(preview.undoAvailable).toBe(true);
    expect(preview.affectedTables).toEqual([]);
    expect(preview.confirmToken.length).toBeGreaterThan(0);
    expect(preview.expiresAt).toBeGreaterThan(Date.now());

    // The minted token is a real, verifiable confirm for exactly { bookmark }.
    expect(
      await confirm.verify('timeTravel.armRestore', { bookmark: 'bm-A' }, preview.confirmToken),
    ).toBe(true);
  });

  it('resolves a TIME target to a concrete bookmark and mints over THAT bookmark', async () => {
    const { port, confirm, stub } = makePort({ forTime: 'bm-T' });
    const preview = await port.preview({ time: 1500 });
    expect(preview.target).toEqual({ id: 'bm-T', kind: 'bookmark', time: 1500 });
    expect(stub.forTimeCalls).toEqual([1500]);
    // Token binds to the RESOLVED bookmark, so the client arms with { bookmark: 'bm-T' }.
    expect(
      await confirm.verify('timeTravel.armRestore', { bookmark: 'bm-T' }, preview.confirmToken),
    ).toBe(true);
  });

  it('404s a time target the DO cannot resolve to a bookmark', async () => {
    const { port } = makePort({ forTime: null });
    await expect(port.preview({ time: 1500 })).rejects.toSatisfy(
      (err: unknown) => errorCode(err) === 'not_found',
    );
  });
});

describe('CloudflareDoTimeTravelPort — armRestore over the RPC hop', () => {
  // The port does NOT re-verify the confirm token: the dispatch registry's 428
  // gate is the sole gate (it verifies + single-use-consumes over the actually-
  // dispatched op, which the port cannot know — armRestore AND undo both call
  // this one method). The registry-owned gate is exercised end-to-end in the
  // dispatch-level suite below; here we assert the RPC hop + outcome mapping.
  it('arms the restore and maps the outcome (restart: false → armed, not applied)', async () => {
    const { port, stub } = makePort({ undo: 'bm-undo-A' });

    // preview still mints a confirm token (the registry gate owns verifying it).
    const preview = await port.preview({ bookmark: 'bm-A' });

    const outcome = await port.armRestore({ bookmark: 'bm-A', confirmToken: preview.confirmToken });

    expect(stub.armCalls).toEqual([{ bookmark: 'bm-A', restart: false }]);
    expect(outcome).toEqual({
      restoredTo: 'bm-A',
      undoMark: { id: 'bm-undo-A', kind: 'bookmark' },
      applied: false,
      restartRequested: false,
    });
  });

  it('restart: true → aborts-to-apply, applied: true, and threads restart into pitrArmRestore', async () => {
    const { port, stub } = makePort();

    const outcome = await port.armRestore({ bookmark: 'bm-A', restart: true, confirmToken: 'tok' });

    expect(stub.armCalls).toEqual([{ bookmark: 'bm-A', restart: true }]);
    expect(outcome.applied).toBe(true);
    expect(outcome.restartRequested).toBe(true);
    expect(outcome.undoMark).toEqual({ id: 'bm-undo', kind: 'bookmark' });
  });
});

describe('CloudflareDoTimeTravelPort — unavailable DO PITR', () => {
  it('maps a DO-PITR-unavailable error (post-RPC-hop shape) to TIMETRAVEL_UNAVAILABLE (409)', async () => {
    const { port } = makePort({ unavailable: true });
    await expect(port.getCurrentMark()).rejects.toSatisfy(
      (err: unknown) => errorCode(err) === 'TIMETRAVEL_UNAVAILABLE',
    );
    // A time preview + armRestore both make the RPC hop, so both surface it.
    // (preview({ bookmark }) resolves locally and never touches the DO — nothing
    // to report unavailable.)
    await expect(port.preview({ time: 1500 })).rejects.toSatisfy(
      (err: unknown) => errorCode(err) === 'TIMETRAVEL_UNAVAILABLE',
    );
  });

  it('also classifies the same-process `code` branch of the unavailable contract', async () => {
    // The other detection branch: a same-process error carrying `code`
    // 'PITR_UNAVAILABLE' (what `DoPitrUnavailableError` sets before any RPC hop).
    const unavailable = (): Promise<never> =>
      Promise.reject(
        Object.assign(new Error('PITR_UNAVAILABLE: no SQLite backend'), {
          code: 'PITR_UNAVAILABLE',
        }),
      );
    const stub: VelaDoPitrRpc = {
      pitrCurrentBookmark: unavailable,
      pitrBookmarkForTime: unavailable,
      pitrArmRestore: unavailable,
    };
    const namespace: DoPitrNamespace = {
      idFromName: (name) => ({ toString: () => name, name }),
      get: () => stub,
    };
    const port = new CloudflareDoTimeTravelPort({
      namespace,
      confirm: new ConfirmTokenSigner('s'),
    });
    await expect(port.getCurrentMark()).rejects.toSatisfy(
      (err: unknown) => errorCode(err) === 'TIMETRAVEL_UNAVAILABLE',
    );
  });
});

// ===========================================================================
// Integration: the panel binds TIME_TRAVEL_PORT and the CF port threads through
// the SAME dispatch registry + 428 confirm gate + studio.capabilities as the
// portable adapter.
// ===========================================================================

const TOKEN = 'test-master-token-value';
const BASE = '/_vela/admin';

type App = Awaited<ReturnType<typeof VelaFactory.create>>;

async function makeCfApp(
  namespace: DoPitrNamespace,
  studio: Partial<StudioModuleOptions> = {},
): Promise<App> {
  @Module({
    imports: [
      StudioModule.forRoot({
        token: TOKEN,
        ...studio,
        plugins: [cloudflareTimeTravelPanel({ binding: 'ROOM' })],
      }),
    ],
  })
  class AppModule {}
  // The panel names the binding; each application reads it from its own ENV.
  return VelaFactory.create(AppModule, { env: { ROOM: namespace } });
}

describe('cloudflareTimeTravelPanel({ binding })', () => {
  it('reads the namespace from ENV when a call first needs it, naming the binding when absent', async () => {
    @Module({
      imports: [
        StudioModule.forRoot({
          token: TOKEN,
          plugins: [cloudflareTimeTravelPanel({ binding: 'ROOM' })],
        }),
      ],
    })
    class AppModule {}
    const app = await VelaFactory.create(AppModule, { env: {} });
    const port = app.get(TIME_TRAVEL_PORT);
    expect(port.capabilities().undo).toBe(true);
    await expect(port.getCurrentMark()).rejects.toThrow(
      "ENV.ROOM is not set: declare the Durable Object namespace binding 'ROOM' under durable_objects.bindings",
    );
    await app.close();
  });
});

function authed(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      'x-forwarded-for': '10.0.0.1',
    },
    body: JSON.stringify(body),
  };
}

async function rpc<Op extends StudioOp>(
  app: App,
  op: Op,
  args?: StudioOpReq<Op>,
): Promise<AdminRpcResponse<StudioOpRes<Op>>> {
  const res = await app
    .getHonoApp()
    .request(`${BASE}/rpc/${op}`, authed(args !== undefined ? { args } : {}));
  return (await res.json()) as AdminRpcResponse<StudioOpRes<Op>>;
}

function ok<T>(res: AdminRpcResponse<T>): T {
  if (!res.ok) throw new Error(`expected ok, got ${JSON.stringify(res)}`);
  return res.data;
}

function challenge<T>(res: AdminRpcResponse<T>): StudioConfirmChallenge {
  if (res.ok) throw new Error(`expected a 428 challenge, got ${JSON.stringify(res)}`);
  expect(res.status).toBe(428);
  expect(res.error.code).toBe('STUDIO_CONFIRM_REQUIRED');
  const d = res.error.details as StudioConfirmChallenge;
  expect(typeof d.confirmToken).toBe('string');
  return d;
}

describe('cloudflareTimeTravelPanel — capabilities through dispatch', () => {
  it('studio.capabilities resolves the CF port’s capabilities the same way as the portable one', async () => {
    const app = await makeCfApp(new FakePitrNamespace(new FakePitrStub()));
    const caps = ok(await rpc(app, 'studio.capabilities'));
    expect(caps.features.timeTravel).toBe(true);
    expect(caps.timeTravel).toMatchObject({
      granularity: 'bookmark',
      restartRequired: true,
      list: false,
      portableExport: false,
    });

    const ttCaps = ok(await rpc(app, 'timeTravel.capabilities', {}));
    expect(ttCaps.granularity).toBe('bookmark');
  });
});

describe('cloudflareTimeTravelPanel — preview → armRestore through the 428 gate', () => {
  it('the preview token clears the registry’s single-use gate and drives pitrArmRestore', async () => {
    const stub = new FakePitrStub({ undo: 'bm-undo-live' });
    const app = await makeCfApp(new FakePitrNamespace(stub), { editable: { timeTravel: true } });

    const preview = ok(
      await rpc(app, 'timeTravel.preview', { target: { bookmark: 'bm-A' } }),
    ) satisfies RestorePreview;
    expect(preview.restartRequired).toBe(true);

    const outcome = ok(
      await rpc(app, 'timeTravel.armRestore', {
        bookmark: 'bm-A',
        confirmToken: preview.confirmToken,
      }),
    ) satisfies RestoreOutcome;
    expect(outcome.applied).toBe(false); // armed for next restart (restart omitted)
    expect(outcome.restartRequested).toBe(false);
    expect(outcome.undoMark).toEqual({ id: 'bm-undo-live', kind: 'bookmark' });
    expect(stub.armCalls).toEqual([{ bookmark: 'bm-A', restart: false }]);
  });

  it('armRestore without a confirm token raises the generic 428 challenge (registry-owned)', async () => {
    const stub = new FakePitrStub();
    const app = await makeCfApp(new FakePitrNamespace(stub), { editable: { timeTravel: true } });

    const res = await rpc(app, 'timeTravel.armRestore', { bookmark: 'bm-A', confirmToken: '' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a 428 challenge');
    expect(res.status).toBe(428);
    expect(res.error.code).toBe('STUDIO_CONFIRM_REQUIRED');
    expect(stub.armCalls).toEqual([]); // never reached the DO
  });
});

// ===========================================================================
// Destructive time-travel ops through the REAL dispatch registry + 428 gate.
// This is the coverage gap that hid the undo bug: `armRestore` AND `undo` BOTH
// route through `port.armRestore`, but the registry mints their confirm tokens
// for DIFFERENT (op, payload) tuples — so an armRestore-only re-verify in the
// port silently broke `undo` after the token was already single-use consumed.
// ===========================================================================

describe('cloudflareTimeTravelPanel — destructive ops through the 428 challenge', () => {
  it('timeTravel.armRestore: no token → 428 → echo token → arms the DO restore', async () => {
    const stub = new FakePitrStub({ undo: 'bm-undo-arm' });
    const app = await makeCfApp(new FakePitrNamespace(stub), { editable: { timeTravel: true } });

    // No token → the registry mints a 428 challenge bound to (armRestore, { bookmark }).
    const ch = challenge(
      await rpc(app, 'timeTravel.armRestore', { bookmark: 'bm-A', confirmToken: '' }),
    );
    expect(ch.summary.toLowerCase()).toContain('restore');
    expect(stub.armCalls).toEqual([]); // the gate blocked before the DO hop

    // Echo the token → the single-use gate clears and the DO is armed.
    const outcome = ok(
      await rpc(app, 'timeTravel.armRestore', { bookmark: 'bm-A', confirmToken: ch.confirmToken }),
    ) satisfies RestoreOutcome;
    expect(outcome.applied).toBe(false); // restart omitted → armed for the next session
    expect(outcome.undoMark).toEqual({ id: 'bm-undo-arm', kind: 'bookmark' });
    expect(stub.armCalls).toEqual([{ bookmark: 'bm-A', restart: false }]);
  });

  it('timeTravel.undo: no token → 428 → echo token → applies (regression: op-mismatched port re-verify broke this)', async () => {
    const stub = new FakePitrStub({ undo: 'bm-undo-mark' });
    const app = await makeCfApp(new FakePitrNamespace(stub), { editable: { timeTravel: true } });

    // Arm a restore first (through its own 428) to obtain an undo mark.
    const armCh = challenge(
      await rpc(app, 'timeTravel.armRestore', { bookmark: 'bm-A', confirmToken: '' }),
    );
    const restored = ok(
      await rpc(app, 'timeTravel.armRestore', {
        bookmark: 'bm-A',
        confirmToken: armCh.confirmToken,
      }),
    ) satisfies RestoreOutcome;
    const undoMarkId = restored.undoMark!.id; // 'bm-undo-mark'

    // `undo` rides its OWN 428 challenge — the registry mints for (undo, { undoMark }).
    // Regression: the port used to re-verify that token against (armRestore,
    // { bookmark }), which never matches, so it threw a fresh 428 AFTER the registry
    // had single-use-consumed the token → undo was PERMANENTLY broken (every retry
    // re-challenged and re-failed), contradicting capabilities().undo === true.
    const undoCh = challenge(
      await rpc(app, 'timeTravel.undo', { undoMark: undoMarkId, confirmToken: '' }),
    );
    const undone = ok(
      await rpc(app, 'timeTravel.undo', {
        undoMark: undoMarkId,
        confirmToken: undoCh.confirmToken,
      }),
    ) satisfies RestoreOutcome;

    expect(undone.restartRequested).toBe(false);
    expect(undone.undoMark).toEqual({ id: 'bm-undo-mark', kind: 'bookmark' });
    // The undo armed a fresh DO restore to the undo mark (bookmark == undoMark).
    expect(stub.armCalls.at(-1)).toEqual({ bookmark: undoMarkId, restart: false });
  });

  it('capabilities().undo === true stays honest — undo actually works end-to-end through dispatch', async () => {
    const stub = new FakePitrStub();
    const app = await makeCfApp(new FakePitrNamespace(stub), { editable: { timeTravel: true } });

    // The advertised capability…
    const caps = ok(await rpc(app, 'timeTravel.capabilities', {}));
    expect(caps.undo).toBe(true);

    // …is backed by a working undo through the registry (mint → echo → apply).
    const undoCh = challenge(
      await rpc(app, 'timeTravel.undo', { undoMark: 'bm-prev', confirmToken: '' }),
    );
    const undone = ok(
      await rpc(app, 'timeTravel.undo', { undoMark: 'bm-prev', confirmToken: undoCh.confirmToken }),
    ) satisfies RestoreOutcome;
    expect(stub.armCalls).toEqual([{ bookmark: 'bm-prev', restart: false }]);
    expect(undone.undoMark).toEqual({ id: 'bm-undo', kind: 'bookmark' });
  });
});
