// @ts-expect-error virtual module supplied by @cloudflare/vitest-plugin
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const origin = 'https://app.test';

async function upgrade(
  room: string,
  options: { origin?: string; ttlMs?: number; authorized?: boolean } = {},
): Promise<Response> {
  return SELF.fetch(`https://worker.test/rooms/${room}/ws`, {
    headers: {
      upgrade: 'websocket',
      origin: options.origin ?? origin,
      'x-test-auth': options.authorized === false ? 'denied' : 'allowed',
      cookie: `session=${options.ttlMs ?? 60_000}`,
    },
  });
}

interface SocketReader {
  socket: WebSocket;
  next(timeoutMs?: number): Promise<unknown>;
}

/**
 * Install one permanent listener before accepting the client side. Real
 * workerd can deliver ready + an immediate response in the same task; swapping
 * one-shot listeners between frames would create a test-only lost-frame race.
 */
function readSocket(socket: WebSocket): SocketReader {
  const buffered: unknown[] = [];
  const waiters: Array<{
    resolve(value: unknown): void;
    reject(error: unknown): void;
  }> = [];

  socket.addEventListener('message', (event) => {
    let value: unknown;
    try {
      value = JSON.parse(String(event.data));
    } catch (error) {
      waiters.shift()?.reject(error);
      return;
    }
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(value);
    else buffered.push(value);
  });

  return {
    socket,
    next(timeoutMs = 2_000): Promise<unknown> {
      const value = buffered.shift();
      if (value !== undefined) return Promise.resolve(value);
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        waiters.push(waiter);
        const timeout = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('timed out waiting for WebSocket frame'));
        }, timeoutMs);
        waiter.resolve = (result): void => {
          clearTimeout(timeout);
          resolve(result);
        };
        waiter.reject = (error): void => {
          clearTimeout(timeout);
          reject(error);
        };
      });
    },
  };
}

function receivesMessageWithin(socket: WebSocket, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onMessage = (): void => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      resolve(false);
    }, timeoutMs);
    socket.addEventListener('message', onMessage, { once: true });
  });
}

async function socketFor(room: string, ttlMs = 60_000): Promise<SocketReader> {
  const response = await upgrade(room, { ttlMs });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  expect(socket).toBeDefined();
  const reader = readSocket(socket!);
  socket!.accept();
  const ready = await reader.next();
  expect(ready).toMatchObject({ event: 'ready' });
  return reader;
}

describe('Cloudflare WebSocket security under workerd', () => {
  it('rejects hostile Origin/auth and failed connection hooks before usable allocation', async () => {
    expect((await upgrade('origin', { origin: 'https://evil.test' })).status).toBe(403);
    expect((await upgrade('auth', { authorized: false })).status).toBe(403);
    expect((await upgrade('reject')).status).toBe(403);
  });

  it('handles an immediate frame, persists identity, and isolates room fan-out', async () => {
    const firstResponse = await upgrade('alpha');
    expect(firstResponse.status).toBe(101);
    const first = firstResponse.webSocket!;
    const firstReader = readSocket(first);
    first.accept();
    // Send without waiting for the ready frame. This is the earliest frame a
    // real client can produce after the DO returns 101 and proves the trusted
    // attachment is active before application-frame dispatch begins.
    first.send(JSON.stringify({ event: 'echo', data: { immediate: true } }));
    expect(await firstReader.next()).toMatchObject({ event: 'ready' });
    expect(await firstReader.next()).toMatchObject({
      event: 'echo',
      data: { body: { immediate: true }, tenantId: 'tenant-1' },
    });

    const sameRoom = await socketFor('alpha');
    const otherRoom = await socketFor('beta');
    first.send(JSON.stringify({ event: 'room', data: { value: 1 } }));
    expect(await firstReader.next()).toMatchObject({ event: 'room', data: { value: 1 } });
    expect(await sameRoom.next()).toMatchObject({ event: 'room', data: { value: 1 } });

    expect(await receivesMessageWithin(otherRoom.socket, 200)).toBe(false);

    first.close(1000, 'done');
    sameRoom.socket.close(1000, 'done');
    otherRoom.socket.close(1000, 'done');
  });

  it("pushes from the Worker to a gateway room's Durable Object through Gateways", async () => {
    const target = await socketFor('push-target');
    const other = await socketFor('push-other');

    const response = await SELF.fetch('https://worker.test/push/push-target', { method: 'POST' });
    expect(await response.json()).toEqual({ pushed: 'push-target' });
    expect(await target.next()).toEqual({ event: 'pushed', data: { room: 'push-target' } });
    expect(await receivesMessageWithin(other.socket, 200)).toBe(false);

    target.socket.close(1000, 'done');
    other.socket.close(1000, 'done');
  });

  it("pushes from a room's Durable Object to its own room and forwards another", async () => {
    const sender = await socketFor('relay-a');
    const receiver = await socketFor('relay-b');

    sender.socket.send(JSON.stringify({ event: 'relay', data: { room: 'relay-a' } }));
    expect(await sender.next()).toEqual({ event: 'relayed', data: { room: 'relay-a' } });
    expect(await receivesMessageWithin(receiver.socket, 200)).toBe(false);

    sender.socket.send(JSON.stringify({ event: 'relay', data: { room: 'relay-b' } }));
    expect(await receiver.next()).toEqual({ event: 'relayed', data: { room: 'relay-b' } });
    expect(await receivesMessageWithin(sender.socket, 200)).toBe(false);

    sender.socket.close(1000, 'done');
    receiver.socket.close(1000, 'done');
  });

  it('admits connections whose hook broadcasts to the room they join', async () => {
    const first = await socketFor('announce');
    const second = await socketFor('announce');
    try {
      // The broadcast reaches the admitted socket; the joining one gets only
      // its own ready frame (checked by socketFor) while it is admitted.
      expect(await first.next()).toMatchObject({ event: 'joined' });
      second.socket.send(JSON.stringify({ event: 'echo', data: 'after-join' }));
      expect(await second.next()).toMatchObject({ event: 'echo', data: { body: 'after-join' } });
    } finally {
      first.socket.close(1000, 'done');
      second.socket.close(1000, 'done');
    }
  });

  it('enforces identity expiry on frames and closes oversized frames with 1009', async () => {
    const { socket: expiring } = await socketFor('expiry', 500);
    await new Promise((resolve) => setTimeout(resolve, 550));
    const expiryClose = new Promise<CloseEvent>((resolve) =>
      expiring.addEventListener('close', resolve, { once: true }),
    );
    expiring.send(JSON.stringify({ event: 'echo', data: 'after-expiry' }));
    expect((await expiryClose).code).toBe(1008);

    const { socket: oversized } = await socketFor('oversized');
    const oversizedClose = new Promise<CloseEvent>((resolve) =>
      oversized.addEventListener('close', resolve, { once: true }),
    );
    oversized.send(JSON.stringify({ event: 'echo', data: 'x'.repeat(65 * 1024) }));
    expect((await oversizedClose).code).toBe(1009);
  });
  it('discovers a request gateway and separates native message state from persisted connection state', async () => {
    const first = await socketFor('scope'),
      second = await socketFor('scope');
    try {
      for (const [reader, expected] of [
        [first, 1],
        [first, 2],
        [second, 1],
      ] as const) {
        reader.socket.send('{"event":"scope"}');
        expect(await reader.next()).toEqual({
          event: 'scope',
          data: { invocationCalls: 1, connectionCalls: expected, connected: true },
        });
      }
      first.socket.send('{"event":"attachment-limit"}');
      expect(await first.next()).toEqual({ event: 'attachment-limit', data: { rejected: true } });
      first.socket.send('{"event":"scope"}');
      expect(await first.next()).toMatchObject({
        data: { invocationCalls: 1, connectionCalls: 3, connected: true },
      });
    } finally {
      first.socket.close(1000, 'done');
      second.socket.close(1000, 'done');
    }
  });
});
