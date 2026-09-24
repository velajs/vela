import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveClient } from '../src/live-client';
import { makeSocketFactory, tick } from './harness';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('browser WebSocket send admission', () => {
  it.each(['rate', 'buffered', 'heartbeat', 'oversize'] as const)(
    'closes and reconnects after %s rejection using a browser-valid code',
    async (mode) => {
      const sockets = makeSocketFactory();
      const client = new LiveClient({
        queries: [],
        url: 'http://api.test',
        WebSocket: sockets.factory,
        sendPolicy: mode === 'rate' ? { maxBytesPerSecond: 1 } : undefined,
        heartbeatIntervalMs: mode === 'heartbeat' ? 100 : 0,
        reconnect: { baseMs: 1, capMs: 1 },
      });
      client.subscribeRaw('query', {}, () => {});
      await tick();
      const socket = sockets.last();
      let closedWith: number | undefined;
      socket.close = (code?: number) => {
        if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999))
          throw new DOMException('Invalid close code');
        closedWith = code;
        socket.readyState = 3;
        // No onclose: local rejection must still schedule recovery.
      };
      if (mode === 'buffered') Object.assign(socket, { bufferedAmount: 2 * 1024 * 1024 });
      socket.open();
      if (mode === 'heartbeat') {
        Object.assign(socket, { bufferedAmount: 2 * 1024 * 1024 });
        await vi.advanceTimersByTimeAsync(100);
      }
      if (mode === 'oversize') socket.onmessage?.({ data: 'x'.repeat(65 * 1024) });
      expect(closedWith).toBe(mode === 'oversize' ? 4009 : 4013);
      expect(socket.readyState).toBe(3);
      expect(client.connectionStatus()).toBe('offline');
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets.sockets).toHaveLength(2);
      client.close();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
