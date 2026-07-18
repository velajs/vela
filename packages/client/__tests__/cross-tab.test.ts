import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientLiveFrame } from '@velajs/live-protocol';
import { CrossTabCoordinator, LiveClient } from '../src/index';
import type { CrossTabCallbacks, WantSpec } from '../src/index';
import type { CrossTabOptions, LiveClientOptions } from '../src/types';
import { broadcastFactory, FakeBroadcastChannel, FakeSocket, makeSocketFactory } from './harness';

type Live = {
  'todos.list': { args: Record<string, never>; result: Array<{ id: string }> };
  'other.list': { args: Record<string, never>; result: Array<{ id: string }> };
};

const CROSS_TAB: CrossTabOptions = {
  appId: 'test-app',
  sessionId: 'session-user-a',
  accountEpoch: 'login-1',
  BroadcastChannel: broadcastFactory,
  channelName: 'test-channel',
  heartbeatMs: 1000,
  leaderTimeoutMs: 3000,
};

function makePair() {
  const sockets = makeSocketFactory();
  const fetchCalls = { a: [] as string[], b: [] as string[] };
  const mkFetch = (bucket: string[]): typeof fetch =>
    (async (url: RequestInfo | URL) => {
      bucket.push(String(url));
      return new Response('{}', {
        status: 200,
        headers: { 'Vela-Commit-Cursor': '3', 'Vela-Commit-Epoch': 'e1' },
      });
    }) as typeof fetch;

  const base = (fetchImpl: typeof fetch): LiveClientOptions => ({
    url: 'http://api.test',
    WebSocket: sockets.factory,
    fetch: fetchImpl,
    crossTab: CROSS_TAB,
    reconnect: { baseMs: 1, capMs: 2 },
  });
  const a = new LiveClient<Live>(base(mkFetch(fetchCalls.a)));
  const b = new LiveClient<Live>(base(mkFetch(fetchCalls.b)));
  return { a, b, sockets, fetchCalls };
}

const subFramesOf = (socket: FakeSocket): Array<Extract<ClientLiveFrame, { t: 'sub' }>> =>
  socket
    .liveFrames()
    .filter((frame): frame is Extract<ClientLiveFrame, { t: 'sub' }> => frame.t === 'sub');

const unsubFramesOf = (socket: FakeSocket): Array<Extract<ClientLiveFrame, { t: 'unsub' }>> =>
  socket
    .liveFrames()
    .filter((frame): frame is Extract<ClientLiveFrame, { t: 'unsub' }> => frame.t === 'unsub');

beforeEach(() => {
  FakeBroadcastChannel.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('cross-tab LiveClient coordination', () => {
  it('opens exactly one socket (leader) and relays values to the follower', async () => {
    const { a, b, sockets } = makePair();
    const aValues: Array<Array<{ id: string }> | undefined> = [];
    const bValues: Array<Array<{ id: string }> | undefined> = [];
    a.subscribe('todos.list', {}, (value) => aValues.push(value));
    b.subscribe('todos.list', {}, (value) => bValues.push(value));

    await vi.advanceTimersByTimeAsync(3100); // A (lower tabId) self-promotes
    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(false);

    sockets.openAll();
    const sub = subFramesOf(sockets.last())[0]?.sub ?? '';
    sockets.last().receive({ t: 'data', sub, snapshot: [{ id: 'a' }], cursor: 1, epoch: 'e1' });

    expect(sockets.sockets).toHaveLength(1);
    expect(aValues.at(-1)).toEqual([{ id: 'a' }]);
    expect(bValues.at(-1)).toEqual([{ id: 'a' }]);
  });

  it('a follower optimistic write drops when the leader relays a covering cursor', async () => {
    const { a, b, sockets, fetchCalls } = makePair();
    const bValues: Array<Array<{ id: string }> | undefined> = [];
    a.subscribe('todos.list', {}, () => {});
    b.subscribe('todos.list', {}, (value) => bValues.push(value));
    await vi.advanceTimersByTimeAsync(3100);
    sockets.openAll();
    const sub = subFramesOf(sockets.last())[0]?.sub ?? '';
    sockets.last().receive({ t: 'data', sub, snapshot: [{ id: 'a' }], cursor: 1, epoch: 'e1' });

    // Follower paints optimistically and fetches directly (no socket of its own).
    const write = b.mutate(
      '/todos',
      {},
      {
        optimistic: {
          query: 'todos.list',
          args: {},
          apply: (t) => [...(Array.isArray(t) ? t : []), { id: 'tmp' }],
        },
      },
    );
    expect((b.peek('todos.list', {}) ?? []).some((row) => row.id === 'tmp')).toBe(true);
    await write;
    expect(fetchCalls.b).toEqual(['http://api.test/todos']);

    // The leader observes a covering frame (cursor 3 = the write's commit) and relays it.
    sockets.last().receive({ t: 'settled', sub, cursor: 3, epoch: 'e1' });
    expect((b.peek('todos.list', {}) ?? []).some((row) => row.id === 'tmp')).toBe(false);
    expect(bValues.at(-1)).toEqual([{ id: 'a' }]);
  });

  it('promotes the follower on leader death and resubscribes from the relayed cursor', async () => {
    const { a, b, sockets } = makePair();
    a.subscribe('todos.list', {}, () => {});
    b.subscribe('todos.list', {}, () => {});
    await vi.advanceTimersByTimeAsync(3100);
    sockets.openAll();
    const leaderSub = subFramesOf(sockets.last())[0]?.sub ?? '';
    sockets
      .last()
      .receive({ t: 'data', sub: leaderSub, snapshot: [{ id: 'a' }], cursor: 7, epoch: 'e1' });

    // Leader dies.
    a.close();
    await vi.advanceTimersByTimeAsync(50);
    expect(b.isLeader()).toBe(true);

    sockets.openAll(); // open B's freshly registered socket
    const bSub = subFramesOf(sockets.last()).find((frame) => frame.query === 'todos.list');
    expect(bSub).toBeDefined();
    expect(bSub?.sinceCursor).toBe(7);
    expect(bSub?.sinceEpoch).toBe('e1');
  });

  it('serves a follower-only query with a shadow subscription and GCs it on unsubscribe', async () => {
    const { a, b, sockets } = makePair();
    a.subscribe('todos.list', {}, () => {}); // gives the leader its socket
    const stopOther = b.subscribe('other.list', {}, () => {});
    await vi.advanceTimersByTimeAsync(3100);
    sockets.openAll();

    const leaderSocket = sockets.last();
    const shadow = subFramesOf(leaderSocket).find((frame) => frame.query === 'other.list');
    expect(shadow).toBeDefined(); // the leader synthesized a shadow sub for the follower-only query
    expect(sockets.sockets).toHaveLength(1); // still one socket (multiplexed)

    stopOther();
    await vi.advanceTimersByTimeAsync(0);
    const unsubbed = unsubFramesOf(leaderSocket).some((frame) => frame.sub === shadow?.sub);
    expect(unsubbed).toBe(true); // the shadow was unregistered
  });
});

describe('CrossTabCoordinator election', () => {
  const spyCallbacks = () => ({
    onBecomeLeader: vi.fn(),
    onResignLeader: vi.fn(),
    onResync: vi.fn(),
    onFrame: vi.fn(),
    onFrameError: vi.fn(),
    onWant: vi.fn(),
    onUnwant: vi.fn(),
    onTabGone: vi.fn(),
  });

  it('is the sole leader immediately when BroadcastChannel is unavailable', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const callbacks = spyCallbacks();
    const coordinator = new CrossTabCoordinator(
      { appId: 'test-app', sessionId: 'session-user-a', accountEpoch: 'login-1' },
      callbacks satisfies CrossTabCallbacks,
    );
    coordinator.start();
    expect(coordinator.isLeader()).toBe(true);
    expect(callbacks.onBecomeLeader).toHaveBeenCalledTimes(1);
    coordinator.stop();
  });

  it('breaks a tie by tabId — the lower id wins', async () => {
    const first = spyCallbacks();
    const second = spyCallbacks();
    const a = new CrossTabCoordinator(CROSS_TAB, first satisfies CrossTabCallbacks);
    const b = new CrossTabCoordinator(CROSS_TAB, second satisfies CrossTabCallbacks);
    expect(a.tabId < b.tabId).toBe(true);
    a.start();
    b.start();
    await vi.advanceTimersByTimeAsync(3100);
    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(false);
    expect(first.onBecomeLeader).toHaveBeenCalledTimes(1);
    expect(second.onBecomeLeader).not.toHaveBeenCalled();
    a.stop();
    b.stop();
  });

  it('self-promotes after the leader timeout when it is the only tab', async () => {
    const callbacks = spyCallbacks();
    const coordinator = new CrossTabCoordinator(CROSS_TAB, callbacks satisfies CrossTabCallbacks);
    coordinator.start();
    expect(coordinator.isLeader()).toBe(false); // still electing
    await vi.advanceTimersByTimeAsync(3100);
    expect(coordinator.isLeader()).toBe(true);
    expect(callbacks.onBecomeLeader).toHaveBeenCalledTimes(1);
    coordinator.stop();
  });

  it('the leader GCs a wanter whose tab goes silent (heartbeat liveness)', async () => {
    const leaderCbs = spyCallbacks();
    const leader = new CrossTabCoordinator(CROSS_TAB, leaderCbs satisfies CrossTabCallbacks);
    const follower = new CrossTabCoordinator(CROSS_TAB, spyCallbacks() satisfies CrossTabCallbacks);
    leader.start();
    follower.start();
    await vi.advanceTimersByTimeAsync(3100); // leader (lower id) wins
    expect(leader.isLeader()).toBe(true);

    const spec: WantSpec = { query: 'todos.list', args: {}, room: 'default' };
    follower.want('default todos.list null', spec);
    expect(leaderCbs.onWant).toHaveBeenCalledTimes(1);

    follower.stop(); // follower goes silent (a follower stop does not broadcast resign)
    await vi.advanceTimersByTimeAsync(4000); // exceeds leaderTimeoutMs with no signal from the follower
    expect(leaderCbs.onTabGone).toHaveBeenCalledWith(follower.tabId);
    leader.stop();
  });

  it('reclaims leadership when the current leader resigns', async () => {
    const aCbs = spyCallbacks();
    const bCbs = spyCallbacks();
    const a = new CrossTabCoordinator(CROSS_TAB, aCbs satisfies CrossTabCallbacks);
    const b = new CrossTabCoordinator(CROSS_TAB, bCbs satisfies CrossTabCallbacks);
    a.start();
    b.start();
    await vi.advanceTimersByTimeAsync(3100);
    expect(a.isLeader()).toBe(true);

    a.stop(); // broadcasts resign
    await vi.advanceTimersByTimeAsync(50);
    expect(b.isLeader()).toBe(true);
    expect(bCbs.onBecomeLeader).toHaveBeenCalledTimes(1);
    b.stop();
  });

  it('does not coordinate across account epochs', async () => {
    const first = new CrossTabCoordinator(CROSS_TAB, spyCallbacks() satisfies CrossTabCallbacks);
    const second = new CrossTabCoordinator(
      { ...CROSS_TAB, accountEpoch: 'login-2' },
      spyCallbacks() satisfies CrossTabCallbacks,
    );
    first.start();
    second.start();
    await vi.advanceTimersByTimeAsync(3100);

    expect(first.isLeader()).toBe(true);
    expect(second.isLeader()).toBe(true);
    first.stop();
    second.stop();
  });

  it('ignores malformed or oversized channel messages', async () => {
    const callbacks = spyCallbacks();
    const coordinator = new CrossTabCoordinator(CROSS_TAB, callbacks satisfies CrossTabCallbacks);
    coordinator.start();
    await vi.advanceTimersByTimeAsync(3100);

    const channel = new FakeBroadcastChannel('test-channel:test-app:session-user-a:login-1');
    const scope = JSON.stringify(['test-app', 'session-user-a', 'login-1']);
    channel.postMessage({
      scope,
      type: 'want',
      tab: 'attacker',
      key: 'x',
      spec: { query: 'q', room: 'r', args: 'x'.repeat(70 * 1024) },
    });
    channel.postMessage({ scope, type: 'heartbeat', tab: 'attacker', ts: -1, leader: true });

    expect(callbacks.onWant).not.toHaveBeenCalled();
    coordinator.stop();
    channel.close();
  });

  it('rejects relayed snapshots with unpaired watermarks', async () => {
    const leaderCallbacks = spyCallbacks();
    const followerCallbacks = spyCallbacks();
    const leader = new CrossTabCoordinator(CROSS_TAB, leaderCallbacks satisfies CrossTabCallbacks);
    const follower = new CrossTabCoordinator(
      CROSS_TAB,
      followerCallbacks satisfies CrossTabCallbacks,
    );
    leader.start();
    follower.start();
    await vi.advanceTimersByTimeAsync(3100);
    const channel = new FakeBroadcastChannel('test-channel:test-app:session-user-a:login-1');
    const scope = JSON.stringify(['test-app', 'session-user-a', 'login-1']);
    channel.postMessage({
      scope,
      type: 'frame',
      tab: leader.tabId,
      key: 'key',
      value: [],
      cursor: 3,
    });
    expect(followerCallbacks.onFrame).not.toHaveBeenCalled();

    channel.postMessage({
      scope,
      type: 'frame',
      tab: leader.tabId,
      key: 'key',
      value: [],
      cursor: 3,
      epoch: 'e1',
    });
    expect(followerCallbacks.onFrame).toHaveBeenCalledWith('key', [], 3, 'e1');
    leader.stop();
    follower.stop();
    channel.close();
  });
});
