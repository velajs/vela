// @ts-expect-error virtual module supplied by @cloudflare/vitest-plugin
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { CommitStamp, InvalidationCommand } from '@velajs/vela/live';

interface LiveRoomNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { invalidate(cmd: InvalidationCommand): Promise<CommitStamp | undefined> };
}

async function invalidateTwice(namespace: LiveRoomNamespace, room: string) {
  const stub = namespace.get(namespace.idFromName(room));
  const first = await stub.invalidate({ room, tags: ['todos'] });
  const second = await stub.invalidate({ room, tags: ['todos'] });
  return [first, second];
}

describe('live cursor log storage under workerd', () => {
  it.each([
    ['with SQLite storage', 'SQLITE_LIVE_ROOM'],
    ['without SQLite storage', 'KV_LIVE_ROOM'],
  ] as const)('stamps invalidations in a Durable Object %s', async (_label, binding) => {
    const namespace: LiveRoomNamespace = Reflect.get(env, binding);
    const [first, second] = await invalidateTwice(namespace, `live-${binding}`);
    expect(first?.cursor).toBe(1);
    expect(second).toEqual({ cursor: 2, epoch: first?.epoch });
  });
});
