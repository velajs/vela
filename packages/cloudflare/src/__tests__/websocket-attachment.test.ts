import { describe, expect, it, vi } from 'vitest';
import { readWsAttachment } from '../websocket/ws-attachment';
import { CfRoomRegistry } from '../websocket/cf-room-registry';
import type { WsLike, DoStateLike } from '../websocket/do-state';

const valid = () => ({
  connId: 'c1',
  state: 'active',
  path: '/ws',
  rooms: ['room'],
  data: { opaque: 1 },
});
describe('WebSocket attachment validation and send state', () => {
  it('migrates versionless records without persisting volatile state', () => {
    const old = valid();
    const parsed = readWsAttachment({ ...old, unsupported: 'discard' });
    expect(parsed).toEqual({ ...old, version: 1 });
    old.rooms.push('other');
    expect(parsed?.rooms).toEqual(['room']);
  });
  it.each([
    { version: 2 },
    { rooms: 'room' },
    { rooms: [1] },
    { rooms: ['room', 'room'] },
    { data: [] },
    { state: 'unknown' },
    { expiresAtMs: 'tomorrow' },
    { maxFrameBytes: 0 },
    { principal: { issuer: 'x', subject: 'u', principalType: 'admin' } },
  ])('rejects malformed persisted state %j', (patch) => {
    expect(readWsAttachment({ ...valid(), ...patch })).toBeUndefined();
  });
  it('does not invoke getters at framework or data boundaries', () => {
    const get = vi.fn(() => 'active');
    expect(readWsAttachment(Object.defineProperty(valid(), 'state', { get }))).toBeUndefined();
    expect(
      readWsAttachment({ ...valid(), data: Object.defineProperty({}, 'x', { get }) }),
    ).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });
  it('shares admission across reconstructed wrappers, but not across sockets or DO registries', () => {
    const socket = (): WsLike => ({
      send: vi.fn(),
      close: vi.fn(),
      serializeAttachment: vi.fn(),
      deserializeAttachment: valid,
    });
    const ws = socket(),
      other = socket();
    const ctx: DoStateLike = {
      id: { toString: () => 'do' },
      acceptWebSocket() {},
      getWebSockets: () => [ws, other],
    };
    const registry = new CfRoomRegistry(ctx);
    registry.setSendPolicyResolver(() => ({ maxBytesPerSecond: 4 }));
    expect(registry.clientFor(ws).trySendRaw('four')).toBe('accepted');
    expect(registry.clientFor(ws).trySendRaw('x')).toBe('backpressure');
    expect(registry.clientFor(other).trySendRaw('four')).toBe('accepted');
    const woken = new CfRoomRegistry(ctx);
    expect(woken.clientFor(other).trySendRaw('four')).toBe('accepted');
  });
  it('does not route malformed rooms during fanout', async () => {
    const ws: WsLike = {
      send: vi.fn(),
      close: vi.fn(),
      serializeAttachment: vi.fn(),
      deserializeAttachment: () => ({ ...valid(), rooms: null }),
    };
    const ctx: DoStateLike = {
      id: { toString: () => 'do' },
      acceptWebSocket() {},
      getWebSockets: () => [ws],
    };
    const registry = new CfRoomRegistry(ctx);
    await registry.deliverLocal({ rooms: [], frame: '{}' });
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalled();
    expect(registry.localIdsInRoom('room')).toEqual([]);
  });
});
