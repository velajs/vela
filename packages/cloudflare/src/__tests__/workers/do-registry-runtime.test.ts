// @ts-expect-error virtual module supplied by @cloudflare/vitest-plugin
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

interface CountingRoomNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { registeredClasses(): Promise<number> };
}

describe('Durable Object construction under workerd', () => {
  it('declares no metadata-registry classes when one environment builds many instances', async () => {
    const namespace: CountingRoomNamespace = env.COUNTING_ROOM;
    const counts: number[] = [];
    // Each name is a separate Durable Object instance, bootstrapped in the same
    // isolate from the same environment and static root.
    for (const name of ['room-a', 'room-b', 'room-c', 'room-d', 'room-e', 'room-a']) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- instances construct in order
      counts.push(await namespace.get(namespace.idFromName(name)).registeredClasses());
    }

    expect(counts[0]).toBeGreaterThan(0);
    expect(new Set(counts)).toEqual(new Set([counts[0]]));
  });
});
