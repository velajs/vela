import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveClient } from '../src/live-client';
import { makeSocketFactory, tick } from './harness';

const PING = '{"event":"$ping"}';
const PONG = '{"event":"$pong"}';

const startClient = async (heartbeatIntervalMs: number) => {
  const sockets = makeSocketFactory();
  const client = new LiveClient({
    queries: [],
    url: 'http://api.test',
    WebSocket: sockets.factory,
    heartbeatIntervalMs,
    reconnect: { baseMs: 1, capMs: 1 },
  });

  client.subscribeRaw('todos.list', {}, () => {});
  await tick();
  const socket = sockets.last();
  socket.open();
  return { client, socket, sockets };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RoomConnection inbound-frame watchdog', () => {
  it('force-closes and reconnects an open socket after 2.5 heartbeat windows without a frame', async () => {
    const { client, socket, sockets } = await startClient(1000);
    // A half-open transport may accept close without ever delivering onclose.
    // The watchdog must still drive the connection through offline/reconnect.
    socket.close = () => {
      socket.readyState = 3;
    };

    expect(client.connectionStatus()).toBe('connected');

    await vi.advanceTimersByTimeAsync(1000);
    socket.onmessage?.({ data: PONG });
    await vi.advanceTimersByTimeAsync(2000);
    expect(socket.readyState).toBe(1);
    expect(socket.sent.filter((frame) => frame === PING)).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.readyState).toBe(3);
    expect(client.connectionStatus()).toBe('offline');

    await vi.advanceTimersByTimeAsync(1);
    expect(sockets.sockets).toHaveLength(2);
    client.close();
  });

  it('keeps an older peer connected until it acknowledges watchdog support', async () => {
    const { client, socket } = await startClient(1000);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(socket.sent.filter((frame) => frame === PING)).toHaveLength(10);
    expect(socket.readyState).toBe(1);
    expect(client.connectionStatus()).toBe('connected');
    client.close();
  });

  it('treats every inbound event as liveness before payload filtering', async () => {
    const { client, socket } = await startClient(1000);
    socket.onmessage?.({ data: PONG });
    const ignoredFrames: unknown[] = [
      PONG,
      'not json',
      new Uint8Array([1]),
      '{"event":"unknown"}',
      new ArrayBuffer(1),
    ];

    for (const data of ignoredFrames) {
      vi.advanceTimersByTime(1000);
      socket.onmessage?.({ data });
    }

    expect(socket.readyState).toBe(1);
    expect(client.connectionStatus()).toBe('connected');
    client.close();
  });

  it.each([0, -1])('disables both ping and watchdog at %i ms', async (heartbeatIntervalMs) => {
    const { client, socket } = await startClient(heartbeatIntervalMs);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(socket.sent).not.toContain(PING);
    expect(socket.readyState).toBe(1);
    expect(client.connectionStatus()).toBe('connected');
    client.close();
  });

  it('does not let a superseded socket frame refresh the current socket watchdog', async () => {
    const { client, socket: first, sockets } = await startClient(1000);

    first.dropFromServer();
    await vi.advanceTimersByTimeAsync(1);
    const second = sockets.last();
    second.open();
    second.onmessage?.({ data: PONG });

    await vi.advanceTimersByTimeAsync(2000);
    first.onmessage?.({ data: '{"event":"$pong"}' });
    await vi.advanceTimersByTimeAsync(1000);

    expect(second.readyState).toBe(3);
    expect(client.connectionStatus()).toBe('offline');
    client.close();
  });
});
