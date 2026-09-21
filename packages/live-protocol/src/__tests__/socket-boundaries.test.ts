import { afterEach, describe, expect, it, vi } from 'vitest';
import { readWebSocketEnvelope, WebSocketSendGate, readLiveEnvelope } from '../index';

const sender = () => ({ readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() });
afterEach(() => vi.useRealTimers());

describe('WebSocket boundary', () => {
  it('keeps valid correlation strings and unknown payloads; rejects malformed known fields', () => {
    expect(readWebSocketEnvelope({ event: 'go', id: '', data: { a: 1 }, extra: true })).toEqual({
      event: 'go',
      id: '',
      data: { a: 1 },
    });
    for (const value of [
      null,
      [],
      { event: 1 },
      { event: 'x', id: null },
      { event: 'x', id: 2 },
      { event: 'x', id: [] },
    ]) {
      expect(readWebSocketEnvelope(value)).toBeUndefined();
    }
    expect(
      readLiveEnvelope({ event: '$live', id: 2, data: { t: 'ack', sub: 's' } }),
    ).toBeUndefined();
  });
  it('does not invoke envelope accessors', () => {
    const get = vi.fn(() => 'event');
    expect(readWebSocketEnvelope(Object.defineProperty({}, 'event', { get }))).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });
  it('refuses buffered sends and oversize UTF-8 frames before writing', () => {
    const socket = sender();
    socket.bufferedAmount = 7;
    expect(new WebSocketSendGate({ maxBufferedBytes: 8 }).trySend(socket, 'é', 10)).toBe(
      'backpressure',
    );
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(1013, expect.any(String));
    expect(new WebSocketSendGate().trySend(socket, 'é', 1)).toBe('too-large');
  });
  it('bounds fixed-window bytes without timers and isolates connections', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const gate = new WebSocketSendGate({ maxBytesPerSecond: 4 });
    const socket = sender();
    expect(gate.trySend(socket, 'four', 10)).toBe('accepted');
    vi.setSystemTime(2000);
    expect(gate.trySend(socket, 'next', 10)).toBe('accepted');
    expect(gate.trySend(socket, 'x', 10)).toBe('backpressure');
    expect(gate.trySend(socket, 'x', 10)).toBe('closed');
    expect(new WebSocketSendGate({ maxBytesPerSecond: 4 }).trySend(sender(), 'four', 10)).toBe(
      'accepted',
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it('distinguishes transport errors from admission and validates policies', () => {
    const socket = sender();
    socket.send.mockImplementation(() => {
      throw new Error('disconnected');
    });
    expect(new WebSocketSendGate().trySend(socket, 'x', 10)).toBe('closed');
    expect(() => new WebSocketSendGate({ maxBytesPerSecond: Infinity })).toThrow(RangeError);
  });
});
