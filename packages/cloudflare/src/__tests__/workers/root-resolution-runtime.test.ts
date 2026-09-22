// @ts-expect-error virtual module supplied by @cloudflare/vitest-plugin
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

interface CountingRoomNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { rootResolutions(): Promise<number> };
}

describe('Durable Object root resolution under workerd', () => {
  it('runs a { create(env) } root once for every instance built from one environment', async () => {
    const namespace: CountingRoomNamespace = env.COUNTING_ROOM;
    const counts: number[] = [];
    // Each name is a separate Durable Object instance in the same isolate.
    for (const name of ['root-a', 'root-b', 'root-c', 'root-a']) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- instances construct in order
      counts.push(await namespace.get(namespace.idFromName(name)).rootResolutions());
    }
    expect(counts).toEqual([1, 1, 1, 1]);
  });
});
