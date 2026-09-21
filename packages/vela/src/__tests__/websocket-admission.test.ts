import { describe, expect, it, vi } from 'vitest';
import { WsMessageQueue } from '../websocket/ws-message-queue';
import { trySendWebSocketFrame } from '../websocket/ws-send';
import type { WsClient } from '../websocket/websocket.types';

describe('WebSocket pending work', () => {
  it('serializes admitted work and drops pending work after overflow', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const overflow = vi.fn();
    const queue = new WsMessageQueue(overflow, 2, 8);
    const seen: number[] = [];
    const first = queue.run('a', async () => {
      seen.push(1);
      await barrier;
    });
    await Promise.resolve();
    const second = queue.run('b', async () => {
      seen.push(2);
    });
    await queue.run('c', async () => {
      seen.push(3);
    });
    expect(overflow).toHaveBeenCalledOnce();
    release();
    await Promise.all([first, second]);
    expect(seen).toEqual([1]);
  });
  it('bounds bytes during connection setup and releases admission after failures', async () => {
    const overflow = vi.fn();
    const limited = new WsMessageQueue(overflow, 10, 3);
    await limited.run('éé', async () => {
      throw new Error('not admitted');
    });
    expect(overflow).toHaveBeenCalledOnce();
    const queue = new WsMessageQueue(overflow, 1, 3);
    await expect(
      queue.run('x', async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    const work = vi.fn(async () => {});
    await queue.run('x', work);
    expect(work).toHaveBeenCalledOnce();
  });
  it('honors explicit rejection and never calls legacy send after it', () => {
    const client: WsClient = {
      id: '1',
      data: {},
      rooms: new Set(),
      raw: null,
      send() {},
      sendRaw: vi.fn(),
      trySendRaw: () => 'backpressure',
      close() {},
      join() {},
      leave() {},
      commit() {},
    };
    expect(trySendWebSocketFrame(client, 'frame')).toBe('backpressure');
    expect(client.sendRaw).not.toHaveBeenCalled();
  });
});
